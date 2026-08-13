import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { TemplateRegistry } from "@aotter/mantle-runtime";
import type { Auth } from "../src/auth/createAuth.js";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountPublicRoutes } from "../src/mount/mountPublicRoutes.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";

function auth(role: string | null): Auth {
  return {
    handler: async () => new Response(null, { status: 404 }),
    getSession: async () => ({
      session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000) },
      user: { id: "u1", email: "x@y.z", name: "User", role, githubLogin: null },
    }),
    getUserRole: async () => role,
    methods: [],
  };
}

function manifests(): Manifest[] {
  return [{
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "Schema",
    metadata: { name: "posts" },
    spec: {
      title: "Posts",
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
      localized: true,
      lifecycle: "publishing",
    },
  }];
}

function harness(
  locales: readonly string[] = ["en"],
  sessionAuth: Auth = stubAuth,
) {
  const db = new InMemoryDatabase();
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate(
    "posts",
    ({ entry, site }) => `<article data-brand="${site.brand}"><h1>${entry.data["title"]}</h1></article>`,
  );
  templates.registerListTemplate(
    "posts",
    ({ entries, site }) => `<section data-brand="${site.brand}">${entries.map((e) => e.data["title"]).join(",")}</section>`,
  );
  const ref = createCmsRef({
    manifests: manifests(),
    templates,
    siteDefaults: {
      title: "Blog",
      brand: "Blog",
      origin: "https://example.com",
      locales,
    },
    bindings: { db, assets: new StubAssetServer() },
    auth: sessionAuth,
  });
  const app = new Hono();
  mountPublicRoutes(app, ref, {
    collectionRoutes: [{ collection: "posts", segment: "posts", listRoute: true }],
    notFoundRenderer: async () => new Response("missing", { status: 404 }),
  });
  return { app, db };
}

function seedPublishedPost(db: InMemoryDatabase, locale = "en"): void {
  db.entries.set(`p1-${locale}`, {
    id: `p1-${locale}`,
    collection: "posts",
    status: "published",
    version: 1,
    data: JSON.stringify({ slug: "hello", locale, title: "Hello", body: "World" }),
    author_id: null,
    created_at: 1,
    updated_at: 2,
  });
}

describe("mountPublicRoutes response-cache contract", () => {
  it("renders list, entry, and markdown from canonical D1 state", async () => {
    const h = harness();
    seedPublishedPost(h.db);

    const list = await h.app.request("/en/posts");
    const entry = await h.app.request("/en/posts/hello");
    const markdown = await h.app.request("/en/posts/hello.md");

    expect(list.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    await expect(list.text()).resolves.toContain("Hello");
    await expect(entry.text()).resolves.toContain("<h1>Hello</h1>");
    await expect(markdown.text()).resolves.toContain("# Hello");
  });

  it("does not retain rendered artifacts inside the Worker", async () => {
    const h = harness();
    seedPublishedPost(h.db);
    await h.app.request("/en/posts/hello");

    const row = h.db.entries.get("p1-en")!;
    h.db.entries.set("p1-en", {
      ...row,
      version: 2,
      data: JSON.stringify({ slug: "hello", locale: "en", title: "Updated", body: "World" }),
      updated_at: 3,
    });
    h.db.siteConfig.set("brand", "Updated Brand");

    const entry = await h.app.request("/en/posts/hello");
    await expect(entry.text()).resolves.toContain("data-brand=\"Updated Brand\"><h1>Updated</h1>");
  });

  it("canonicalizes locale casing and returns 404 for missing content", async () => {
    const h = harness(["en", "zh-TW"]);
    seedPublishedPost(h.db, "zh-TW");

    expect((await h.app.request("/zh-tw/posts/hello")).status).toBe(200);
    expect((await h.app.request("/zh-tw/posts/missing")).status).toBe(404);
  });

  it("keeps preview staff-only and prefers the draft", async () => {
    const denied = harness();
    seedPublishedPost(denied.db);
    expect((await denied.app.request("/en/posts/hello?preview=1")).status).toBe(401);

    const customer = harness(["en"], auth(null));
    seedPublishedPost(customer.db);
    expect((await customer.app.request("/en/posts/hello?preview=1")).status).toBe(403);

    const staff = harness(["en"], auth("editor"));
    seedPublishedPost(staff.db);
    staff.db.entries.set("draft", {
      ...staff.db.entries.get("p1-en")!,
      id: "draft",
      status: "draft",
      data: JSON.stringify({ slug: "hello", locale: "en", title: "Draft wins", body: "" }),
      updated_at: 3,
    });
    const response = await staff.app.request("/en/posts/hello?preview=1");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Draft wins");
  });

  it("composes locale and root llms.txt from D1", async () => {
    const h = harness(["en", "zh-TW"]);
    seedPublishedPost(h.db, "en");
    seedPublishedPost(h.db, "zh-TW");

    const locale = await h.app.request("/en/llms.txt");
    const root = await h.app.request("/llms.txt");
    expect(locale.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    await expect(locale.text()).resolves.toContain("Locale: en");
    const rootBody = await root.text();
    expect(rootBody).toContain("Locale: en");
    expect(rootBody).toContain("Locale: zh-TW");
    expect((await h.app.request("/fr/llms.txt")).status).toBe(404);
  });
});
