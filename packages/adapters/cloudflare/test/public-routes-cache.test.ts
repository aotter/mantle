import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { llmsTxtKey, TemplateRegistry } from "@aotter/mantle-runtime";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { mountPublicRoutes } from "../src/mount/mountPublicRoutes.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import type { Auth } from "../src/auth/createAuth.js";
import {
  InMemoryKv,
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

function staffAuth(role: "owner" | "editor" | "contributor" = "owner"): Auth {
  return {
    handler: async () => new Response(null, { status: 404 }),
    getSession: async () => ({
      session: { id: "s1", userId: "u1", expiresAt: new Date(Date.now() + 60_000) },
      user: { id: "u1", email: "x@y.z", name: "Staff", role, githubLogin: "staff" },
    }),
    getUserRole: async () => role,
    methods: [],
  };
}

function manifests(): Manifest[] {
  return [
    {
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
        lifecycle: "simple",
      },
    },
  ];
}

function harness(locales: readonly string[] = ["en"], opts: { auth?: Auth } = {}) {
  const db = new InMemoryDatabase();
  const kv = new InMemoryKv();
  const templates = new TemplateRegistry();
  templates.registerEntryTemplate("posts", ({ entry, site }) => `<article data-brand="${site.brand}"><h1>${entry.data["title"]}</h1></article>`);
  templates.registerListTemplate("posts", ({ entries, site }) => `<section data-brand="${site.brand}">${entries.map((e) => e.data["title"]).join(",")}</section>`);
  const ref = createCmsRef({
    manifests: manifests(),
    templates,
    siteDefaults: {
      title: "Blog",
      brand: "Blog",
      origin: "https://example.com",
      locales,
    },
    bindings: {
      db,
      kv,
      assets: new StubAssetServer(),
    },
    auth: opts.auth ?? stubAuth,
  });
  const app = new Hono();
  mountPublicRoutes(app, ref, {
    collectionRoutes: [{ collection: "posts", segment: "posts", listRoute: true }],
    notFoundRenderer: async () => new Response("missing", { status: 404 }),
  });
  return { app, db, kv };
}

function seedPublishedPost(db: InMemoryDatabase, locale = "en"): void {
  const id = `p1-${locale}`;
  db.entries.set(id, {
    id,
    collection: "posts",
    status: "published",
    version: 1,
    data: JSON.stringify({
      slug: "hello",
      locale,
      title: "Hello",
      body: "World",
    }),
    author_id: null,
    created_at: 1,
    updated_at: 2,
  });
}

describe("mountPublicRoutes read-through cache", () => {
  it("renders list HTML from D1 on KV miss and populates KV", async () => {
    const h = harness();
    seedPublishedPost(h.db);

    const res = await h.app.request("/en/posts");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    await expect(res.text()).resolves.toContain("<section data-brand=\"Blog\">Hello</section>");
    await expect(h.kv.get("list:html:en/posts")).resolves.toContain("<section data-brand=\"Blog\">Hello</section>");
  });

  it("renders entry HTML from D1 on KV miss and populates KV", async () => {
    const h = harness();
    seedPublishedPost(h.db);

    const res = await h.app.request("/en/posts/hello");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    await expect(res.text()).resolves.toContain("<h1>Hello</h1>");
    await expect(h.kv.get("entry:html:en/posts/hello")).resolves.toContain("<h1>Hello</h1>");
  });

  it("canonicalizes locale casing before D1 lookup and KV population", async () => {
    const h = harness(["en", "zh-TW"]);
    seedPublishedPost(h.db, "zh-TW");

    const list = await h.app.request("/zh-tw/posts");
    expect(list.status).toBe(200);
    await expect(list.text()).resolves.toContain("<section data-brand=\"Blog\">Hello</section>");
    await expect(h.kv.get("list:html:zh-tw/posts")).resolves.toContain("<section data-brand=\"Blog\">Hello</section>");

    const entry = await h.app.request("/zh-tw/posts/hello");
    expect(entry.status).toBe(200);
    await expect(entry.text()).resolves.toContain("<h1>Hello</h1>");
    await expect(h.kv.get("entry:html:zh-tw/posts/hello")).resolves.toContain("<h1>Hello</h1>");
  });

  it("uses operator-edited site_config for read-through renders", async () => {
    const h = harness();
    h.db.siteConfig.set("brand", "Operator Brand");
    seedPublishedPost(h.db);

    const list = await h.app.request("/en/posts");
    expect(list.status).toBe(200);
    await expect(list.text()).resolves.toContain("data-brand=\"Operator Brand\"");

    const entry = await h.app.request("/en/posts/hello");
    expect(entry.status).toBe(200);
    await expect(entry.text()).resolves.toContain("data-brand=\"Operator Brand\"");
  });

  it("renders markdown from D1 on KV miss and populates KV", async () => {
    const h = harness();
    seedPublishedPost(h.db);

    const res = await h.app.request("/en/posts/hello.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    const body = await res.text();
    expect(body).toContain("# Hello");
    expect(body).toContain("World");
    await expect(h.kv.get("entry:md:en/posts/hello")).resolves.toContain("# Hello");
  });

  it("returns 404 without populating KV when D1 has no published entry", async () => {
    const h = harness();

    const res = await h.app.request("/en/posts/ghost");
    expect(res.status).toBe(404);
    await expect(h.kv.get("entry:html:en/posts/ghost")).resolves.toBeNull();
  });

  it("preview returns 401 without a session", async () => {
    const h = harness();
    seedPublishedPost(h.db);
    const res = await h.app.request("/en/posts/hello?preview=1");
    expect(res.status).toBe(401);
  });

  it("preview returns 403 for a non-staff session", async () => {
    // stubAuth has getUserRole → null; staffAuth("contributor") still
    // qualifies as staff, so build a custom auth that returns no role.
    const customerAuth: Auth = {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        session: { id: "s", userId: "u", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u", email: "x@y.z", name: "Customer", role: null, githubLogin: null },
      }),
      getUserRole: async () => null,
      methods: [],
    };
    const h = harness(["en"], { auth: customerAuth });
    seedPublishedPost(h.db);
    const res = await h.app.request("/en/posts/hello?preview=1");
    expect(res.status).toBe(403);
  });

  it("preview returns 200 for a staff session", async () => {
    const h = harness(["en"], { auth: staffAuth("editor") });
    seedPublishedPost(h.db);
    const res = await h.app.request("/en/posts/hello?preview=1");
    expect(res.status).toBe(200);
  });

  it("preview returns 403 when getUserRole returns a non-staff role string", async () => {
    // Defends against future extension where getUserRole might return
    // a custom role (e.g. "viewer") not in STAFF_ROLE_SET.
    const oddRoleAuth: Auth = {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        session: { id: "s", userId: "u", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u", email: "x@y.z", name: "Viewer", role: null, githubLogin: null },
      }),
      getUserRole: async () => "viewer",
      methods: [],
    };
    const h = harness(["en"], { auth: oddRoleAuth });
    seedPublishedPost(h.db);
    const res = await h.app.request("/en/posts/hello?preview=1");
    expect(res.status).toBe(403);
  });
});

describe("mountPublicRoutes llms.txt live-fallback", () => {
  it("returns KV value on hit without recomposing", async () => {
    const h = harness(["en"]);
    seedPublishedPost(h.db);
    await h.kv.put("llms:en", "# Cached from KV\n\n## posts\n\n- [Cached](https://example.com/en/posts/cached.md)\n");

    const res = await h.app.request("/en/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# Cached from KV");
    expect(body).not.toContain("Hello"); // the seeded D1 entry — composer would have included it
  });

  it("composes per-locale llms.txt live on KV miss and writes back", async () => {
    const h = harness(["en"]);
    seedPublishedPost(h.db);

    // KV is empty for `llms:en`.
    expect(await h.kv.get("llms:en")).toBeNull();

    const res = await h.app.request("/en/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# Blog");
    expect(body).toContain("Locale: en");
    expect(body).toContain("## posts");
    expect(body).toContain("Hello");
    expect(body).toMatch(/https:\/\/example\.com\/en\/posts\/hello\.md/);

    // Cache write-back populated KV — InMemoryKv is synchronous, so
    // by the time we observe it the write has landed.
    const cached = await h.kv.get("llms:en");
    expect(cached).toBe(body);
  });

  it("composes cross-locale root llms.txt by concatenating per-locale sections", async () => {
    const h = harness(["en", "zh-TW"]);
    seedPublishedPost(h.db, "en");
    seedPublishedPost(h.db, "zh-TW");

    await h.kv.put("llms:root", "# Stale alpha.58 value");
    const rootKey = llmsTxtKey("");
    expect(rootKey).toBe("llms:root:v2");
    expect(await h.kv.get(rootKey)).toBeNull();

    const res = await h.app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300");
    const body = await res.text();
    // Both locale sections present in the aggregate.
    expect(body).toContain("Locale: en");
    expect(body).toContain("Locale: zh-TW");
    // URLs carry the right locale prefix per section.
    expect(body).toMatch(/https:\/\/example\.com\/en\/posts\/hello\.md/);
    expect(body).toMatch(/https:\/\/example\.com\/zh-tw\/posts\/hello\.md/);
    // Cache write-back lands at the root key.
    expect(body).not.toContain("Stale alpha.58");
    const cached = await h.kv.get(rootKey);
    expect(cached).toBe(body);
    expect(h.kv._ttl(rootKey)).toBe(300);
  });

  it("never returns 404 from /llms.txt — always composes at minimum the site header", async () => {
    // Empty DB. Composer still emits title + description header.
    const h = harness(["en"]);

    const res = await h.app.request("/en/llms.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# Blog");
    // No collections, no entries — but no 404 either.
    expect(body).not.toContain("not found");
  });

  it("rejects /:locale/llms.txt with an unknown locale", async () => {
    const h = harness(["en"]);
    const res = await h.app.request("/fr/llms.txt");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
