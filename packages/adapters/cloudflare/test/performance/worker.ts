import { Hono } from "hono";
import type { Manifest } from "@aotter/mantle-spec";
import { TemplateRegistry } from "@aotter/mantle-runtime";
import {
  D1DatabaseDriver,
  KvCacheBinding,
  createCmsRef,
  mountPublicRoutes,
  mountServerEndpoints,
  type D1QueryMetric,
} from "../../src/index.js";
import { StubAssetServer, stubAuth } from "../fakes/runtime-bindings.js";

interface Env {
  readonly DB: D1Database;
  readonly CACHE: KVNamespace;
}

const manifests: Manifest[] = [
  {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "posts" },
    spec: {
      title: "Posts",
      localized: true,
      lifecycle: "simple",
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

let activeMetrics: D1QueryMetric[] | null = null;
let state: ReturnType<typeof createState> | null = null;

function createState(env: Env) {
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate("posts", ({ entry }) =>
    `<article><h1>${entry.data["title"]}</h1><p>${entry.data["body"]}</p></article>`);
  templates.registerListTemplate("posts", ({ entries }) =>
    `<main>${entries.map((entry) => `<h2>${entry.data["title"]}</h2>`).join("")}</main>`);
  const ref = createCmsRef({
    manifests,
    templates,
    siteDefaults: {
      title: "Mantle performance fixture",
      brand: "Mantle",
      origin: "https://example.test",
      locales: ["en"],
    },
    bindings: {
      db: new D1DatabaseDriver(env.DB, (metric) => activeMetrics?.push(metric)),
      kv: new KvCacheBinding(env.CACHE),
      assets: new StubAssetServer(),
    },
    auth: stubAuth,
  });
  const app = new Hono();
  mountServerEndpoints(app, ref);
  mountPublicRoutes(app, ref, {
    collectionRoutes: [{ collection: "posts", segment: "posts", listRoute: true }],
    notFoundRenderer: async () => new Response("not found", { status: 404 }),
  });
  return { app, ref };
}

async function seed(env: Env, until: number): Promise<Response> {
  const current = state ??= createState(env);
  await current.ref.get();
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM entries")
    .first<{ count: number }>();
  const start = Number(row?.count ?? 0);
  const target = Math.max(start, Math.min(50_000, Math.floor(until)));
  for (let offset = start; offset < target; offset += 80) {
    const statements: D1PreparedStatement[] = [];
    for (let index = offset; index < Math.min(offset + 80, target); index += 1) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO entries
         (id, collection, status, version, data, author_id, created_at, updated_at)
         VALUES (?, 'posts', ?, 1, ?, NULL, ?, ?)`,
      ).bind(
        `post-${index}`,
        index % 5 === 0 ? "published" : "draft",
        JSON.stringify({
          slug: `post-${index}`,
          locale: "en",
          title: `Post ${index}`,
          body: `Fixture row ${index}`,
        }),
        index,
        index,
      ));
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
    if (url.pathname === "/__seed") {
      return seed(env, Number(url.searchParams.get("until") ?? 0));
    }

    const current = state ??= createState(env);
    const metrics: D1QueryMetric[] = [];
    activeMetrics = metrics;
    try {
      const response = await current.app.fetch(request, env, executionCtx);
      const measured = new Response(response.body, response);
      measured.headers.set("x-mantle-query-count", String(metrics.length));
      measured.headers.set(
        "x-mantle-rows-read",
        String(metrics.reduce((sum, metric) => sum + metric.rowsRead, 0)),
      );
      return measured;
    } finally {
      activeMetrics = null;
    }
  },
};
