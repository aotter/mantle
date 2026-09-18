import type { Hono } from "hono";
import type { Manifest } from "@aotter/mantle-spec";
import { TemplateRegistry, createPublicPathResolver } from "@aotter/mantle-web";
import {
  D1DatabaseDriver,
  createMantleWorker,
  mountPublicRoutes,
} from "../../src/index.js";
import { instrumentD1, runWithRequestDiagnostics, type RequestDiagnosticRecord } from "../../src/testing.js";
import { compileTestPlan } from "../compileTestPlan.js";
import { stubAuth } from "../fakes/runtime-bindings.js";

interface Env {
  readonly DB: D1Database;
}

const staffAuth = {
  ...stubAuth,
  getSession: async () => ({
    session: { id: "performance-session", userId: "performance-user", expiresAt: new Date(0) },
    user: {
      id: "performance-user",
      email: "performance@example.test",
      name: "Performance",
      role: "owner",
      githubLogin: null,
    },
  }),
  getUserRole: async () => "owner",
};

const manifests: Manifest[] = [
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "posts" },
    spec: {
      title: "Posts",
      localized: true,
      lifecycle: "publishing",
      schema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          locale: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["slug", "locale", "title"],
      },
      uniqueIndexes: [["slug", "locale"]],
    },
  },
  ...["comments", "reactions", "audits"].map((name): Manifest => ({
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name },
    spec: {
      title: name,
      lifecycle: "publishing",
      schema: {
        type: "object",
        properties: {
          postId: { type: "string", "x-mantle-ref": "posts" },
          body: { type: "string" },
        },
        required: ["postId"],
      },
      indexes: [["postId"]],
    },
  })),
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Procedure",
    metadata: { name: "create-comment" },
    spec: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          postId: { type: "string" },
          body: { type: "string" },
        },
        required: ["postId", "body"],
      },
      output: { type: "object" },
      handler: { kind: "builtin", op: "create", schema: "comments" },
    },
  },
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Trigger",
    metadata: { name: "create-comment-http" },
    spec: {
      source: { kind: "http", method: "POST", path: "/api/comments" },
      target: { procedure: "create-comment" },
    },
  },
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name: "recent-posts" },
    spec: {
      surface: "public",
      from: "posts",
      filter: { eq: { field: "status", value: "published" } },
      fields: ["id", "slug", "title", "updatedAt"],
      orderBy: [{ field: "updatedAt", direction: "desc" }],
      limit: 20,
    },
  },
];

let routeCount = 0;
let state: ReturnType<typeof createState> | null = null;

function createState(env: Env) {
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate("posts", ({ entry }) =>
    `<article><h1>${entry.data["title"]}</h1><p>${entry.data["body"]}</p></article>`);
  templates.registerListTemplate("posts", ({ entries }) =>
    `<main>${entries.map((entry) => `<h2>${entry.data["title"]}</h2>`).join("")}</main>`);
  const worker = createMantleWorker({
    plan: compileTestPlan(routeCount ? [
      ...manifests.filter((manifest) => manifest.kind !== "Trigger"),
      ...Array.from({ length: routeCount }, (_, index): Manifest => ({
        apiVersion: "cms.mantle.aotter.net/v1", kind: "Trigger", metadata: { name: `scaled-${index}` },
        spec: {
          source: { kind: "http", method: "POST", path: `/api/scaled-${String(index).padStart(4, "0")}` },
          target: { procedure: "create-comment" },
        },
      })),
    ] : manifests),
    templates,
    publicPathResolver: createPublicPathResolver({ collectionRoutes: { posts: { segment: "posts" } } }),
    siteDefaults: {
      title: "Mantle performance fixture",
      brand: "Mantle",
      origin: "https://example.test",
      locales: ["en"],
    },
    bindings: () => ({
      db: new D1DatabaseDriver(instrumentD1(env.DB), () => {}),
      adminAssets: { fetch: async () => new Response("<!doctype html><title>Admin fixture</title>", { headers: { "content-type": "text/html" } }) },
    }),
    auth: () => staffAuth,
    extend: () => ({ mount: ({ app, ref }) => {
      app.get("/health", (c) => c.text("ok"));
      mountPublicRoutes(app as Hono, ref, {
        collectionRoutes: [{ collection: "posts", segment: "posts", listRoute: true }],
        notFoundRenderer: async () => new Response("not found", { status: 404 }),
      });
    } }),
  });
  return { worker };
}

async function seed(env: Env, until: number): Promise<Response> {
  const current = state ??= createState(env);
  await current.worker.getRuntime(env);
  const row = await env.DB
    .prepare('SELECT COUNT(*) AS count FROM "posts"')
    .first<{ count: number }>();
  const start = Number(row?.count ?? 0);
  const target = Math.max(start, Math.min(50_000, Math.floor(until)));
  for (let offset = start; offset < target; offset += 20) {
    const statements: D1PreparedStatement[] = [];
    for (let index = offset; index < Math.min(offset + 20, target); index += 1) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO "posts"
         (_mantle_id, _mantle_status, _mantle_version, slug, locale, title, body,
          _mantle_author_id, _mantle_created_at, _mantle_updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`,
      ).bind(
        `post-${index}`,
        index % 5 === 0 ? "published" : "draft",
        `post-${index}`,
        "en",
        `Post ${index}`,
        `Fixture row ${index}`,
        Date.now() - (index % 20) * 86_400_000 - 60_000,
        index,
      ));
      for (const collection of ["comments", "reactions", "audits"]) {
        statements.push(env.DB.prepare(
          `INSERT OR IGNORE INTO "${collection}"
           (_mantle_id, _mantle_status, _mantle_version, "postId", body,
            _mantle_author_id, _mantle_created_at, _mantle_updated_at)
           VALUES (?, 'published', 1, ?, ?, NULL, ?, ?)`,
        ).bind(
          `${collection}-${index}`,
          index === 0 ? "post-99" : "post-0",
          `Fixture ${collection} row ${index}`,
          index,
          index,
        ));
      }
    }
    await env.DB.batch(statements);
  }
  await env.DB.prepare("ANALYZE").run();
  return Response.json({ rows: target });
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__health") return new Response("ok");
    if (url.pathname === "/__reset") {
      routeCount = Math.min(1000, Math.max(0, Number(url.searchParams.get("routes")) || 0));
      state = null;
      return new Response("reset");
    }
    if (url.pathname === "/__seed") {
      return seed(env, Number(url.searchParams.get("until") ?? 0));
    }

    let record: RequestDiagnosticRecord | undefined;
    const response = await runWithRequestDiagnostics({ surface: "web", bindings: { d1: true } },
      () => (state ??= createState(env)).worker.fetch(request, env, executionCtx),
      (value) => { record = value; });
    const measured = new Response(response.body, response);
    measured.headers.set("x-mantle-query-count", String(record!.d1!.statements));
    measured.headers.set("x-mantle-rows-read", String(record!.d1!.rowsRead ?? 0));
    return measured;
  },
};
