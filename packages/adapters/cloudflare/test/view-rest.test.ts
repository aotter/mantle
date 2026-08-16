import { compileTestPlan } from "./compileTestPlan.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { mountTestEndpoints } from "./mountTestEndpoints.js";
import type { Auth } from "../src/auth/createAuth.js";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

/**
 * Public View REST surface (ADR-0012). Every parsed View auto-exposes
 * `GET /api/views/<name>`; reserved query string knobs `page` / `show`
 * page through results, declared `View.spec.params` are coerced from
 * strings to their JSON Schema type.
 */
function manifests(): Manifest[] {
  const apiVersion = "cms.mantle.aotter.net/v1" as const;
  return [
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "posts" },
      spec: {
        title: "Posts",
        schema: {
          type: "object",
          properties: {
            slug: { type: "string" },
            locale: { type: "string" },
          },
          required: ["slug"],
        },
        localized: true,
        lifecycle: "publishing",
      },
    },
    {
      apiVersion,
      kind: "View",
      metadata: { name: "postsPublished" },
      spec: {
        surface: "public",
        from: "posts",
        filter: { eq: { field: "status", value: "published" } },
      },
    },
    {
      apiVersion,
      kind: "View",
      metadata: { name: "postsByLocale" },
      spec: {
        surface: "public",
        from: "posts",
        params: {
          type: "object",
          properties: { locale: { type: "string" } },
          required: ["locale"],
        },
        filter: {
          and: [
            { eq: { field: "status", value: "published" } },
            { eq: { field: "locale", value: { $param: "locale" } } },
          ],
        },
        limit: 10,
      },
    },
  ];
}

function harness(seed?: (db: InMemoryDatabase) => void) {
  const db = new InMemoryDatabase();
  if (seed) seed(db);
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(manifests()),
    siteDefaults: { locales: ["en", "zh-TW"] },
    bindings: {
      db,
      adminAssets: new StubAssetServer(),
    },
    auth: stubAuth,
  });
  const app = new Hono();
  mountTestEndpoints(app, ref);
  return { app, db };
}

/** A staff session (owner) for exercising the `/admin/api/*` gate. */
const staffAuth: Auth = {
  ...stubAuth,
  getSession: async () => ({
    session: { id: "s", userId: "u", expiresAt: new Date(Date.now() + 60_000) },
    user: { id: "u", email: "x@y.z", name: "Staff", role: "owner", githubLogin: null },
  }),
  getUserRole: async () => "owner",
};

/** Base fixture + two `surface: staff` Views — `ordersRecent` (titled)
 *  and `ordersArchive` (untitled, #443 null-fallback coverage) — so the
 *  same harness exercises both the public surface (`postsPublished`
 *  stays public) and the staff surface (#433). `auth` defaults to a
 *  staff session; override to `stubAuth` to test the unauthenticated
 *  gate. */
function staffHarness(
  seed?: (db: InMemoryDatabase) => void,
  auth: Auth = staffAuth,
) {
  const db = new InMemoryDatabase();
  if (seed) seed(db);
  const staffViewManifests: Manifest[] = [
    ...manifests(),
    {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "View",
      metadata: { name: "ordersRecent" },
      spec: {
        title: { en: "Recent Orders", "zh-TW": "最新訂單" },
        from: "posts",
        surface: "staff",
        fields: ["id", "slug", "locale"],
        uiSchema: {
          list: {
            columns: ["id", "slug", "locale"],
            searchFields: ["slug"],
            filterFields: ["locale"],
          },
        },
      },
    },
    // #443 — untitled staff View, alongside the titled one above, so
    // the views-manifest test can assert the untitled case falls back
    // to `null` (not to omitting the key) without a second harness.
    {
      apiVersion: "cms.mantle.aotter.net/v1",
      kind: "View",
      metadata: { name: "ordersArchive" },
      spec: {
        from: "posts",
        surface: "staff",
      },
    },
  ];
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(staffViewManifests),
    siteDefaults: { locales: ["en", "zh-TW"] },
    bindings: { db, adminAssets: new StubAssetServer() },
    auth,
  });
  const app = new Hono();
  mountTestEndpoints(app, ref);
  return { app, db };
}

function row(id: string, data: Record<string, unknown>, status = "published") {
  return {
    id,
    collection: "posts",
    status,
    version: 1,
    data: JSON.stringify(data),
    author_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("GET /api/views/<name>", () => {
  it("returns matching rows for a static View", async () => {
    const h = harness((db) => {
      db.entries.set("p1", row("p1", { slug: "a", locale: "en" }));
      db.entries.set("p2", row("p2", { slug: "b", locale: "zh-TW" }));
      db.entries.set("p3", row("p3", { slug: "c", locale: "en" }, "draft"));
    });
    const res = await h.app.request("/api/views/postsPublished");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { rows: unknown[]; page: number; show: number; hasMore: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.page).toBe(1);
    expect(body.data.hasMore).toBe(false);
  });

  it("filters by required param via { $param: locale }", async () => {
    const h = harness((db) => {
      db.entries.set("p1", row("p1", { slug: "a", locale: "en" }));
      db.entries.set("p2", row("p2", { slug: "b", locale: "zh-TW" }));
    });
    const res = await h.app.request("/api/views/postsByLocale?locale=zh-TW");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { rows: Array<{ id: string }> };
    };
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0]!.id).toBe("p2");
  });

  it("returns 400 INPUT_VALIDATION_FAILED when a required param is missing", async () => {
    const h = harness();
    const res = await h.app.request("/api/views/postsByLocale");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; diagnostic: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.diagnostic.code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("clamps ?show beyond View.spec.limit", async () => {
    const h = harness((db) => {
      for (let i = 0; i < 25; i++) {
        db.entries.set(`p${i}`, row(`p${i}`, { slug: `s${i}`, locale: "en" }));
      }
    });
    const res = await h.app.request("/api/views/postsByLocale?locale=en&show=1000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { rows: unknown[]; show: number; hasMore: boolean };
    };
    // View declares limit: 10 → server caps show.
    expect(body.data.show).toBe(10);
    expect(body.data.rows).toHaveLength(10);
    expect(body.data.hasMore).toBe(true);
  });

  it("paginates with ?page=2", async () => {
    const h = harness((db) => {
      for (let i = 0; i < 5; i++) {
        db.entries.set(`p${i}`, row(`p${i}`, { slug: `s${i}`, locale: "en" }));
      }
    });
    const res = await h.app.request("/api/views/postsByLocale?locale=en&show=2&page=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { rows: unknown[]; page: number; show: number; hasMore: boolean };
    };
    expect(body.data.page).toBe(2);
    expect(body.data.show).toBe(2);
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.hasMore).toBe(true);
  });

  it("404s on an undeclared View name", async () => {
    const h = harness();
    const res = await h.app.request("/api/views/doesNotExist");
    expect(res.status).toBe(404);
  });

  it("auth-gated View on HTTP route plumbs ctx — passes when staff session is present (#210 PR12 C1)", async () => {
    // The route must build a HandlerContext from the Better Auth
    // cookie session and forward it as ExecuteViewRequest.ctx, else
    // every auth-gated View returns UNAUTHENTICATED for every caller.
    // We validate the plumbing here by registering an auth-gated View
    // and a staff session; the view should resolve.
    const ownerAuth: Auth = {
      ...stubAuth,
      getSession: async () => ({
        session: { id: "s", userId: "u", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u", email: "x@y.z", name: "Staff", role: "owner", githubLogin: null },
      }),
      getUserRole: async () => "owner",
    };
    const gatedManifests: Manifest[] = [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "staffOnly" },
        spec: {
          surface: "public",
          from: "posts",
          requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
        },
      },
    ];
    const db = new InMemoryDatabase();
    db.entries.set("p1", row("p1", { slug: "hi", locale: "en" }));
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan(gatedManifests),
      siteDefaults: { locales: ["en"] },
      bindings: { db, adminAssets: new StubAssetServer() },
      auth: ownerAuth,
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);
    const res = await app.request("/api/views/staffOnly");
    expect(res.status).toBe(200);
  });

  it("auth-gated View on HTTP route rejects with UNAUTHENTICATED when no session", async () => {
    const gatedManifests: Manifest[] = [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "staffOnly2" },
        spec: {
          surface: "public",
          from: "posts",
          requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
        },
      },
    ];
    const db = new InMemoryDatabase();
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan(gatedManifests),
      siteDefaults: { locales: ["en"] },
      bindings: { db, adminAssets: new StubAssetServer() },
      auth: stubAuth,
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);
    const res = await app.request("/api/views/staffOnly2");
    expect(res.status).toBe(401);
    const body = await res.json() as { ok: boolean; diagnostic?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.diagnostic?.code).toBe("UNAUTHENTICATED");
  });

  it("auth-gated View returns 403 AUTH_DENIED when session exists but role insufficient (#210 PR13)", async () => {
    const customerAuth: Auth = {
      ...stubAuth,
      getSession: async () => ({
        session: { id: "s", userId: "u", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u", email: "x@y.z", name: "Customer", role: null, githubLogin: null },
      }),
      getUserRole: async () => null,
    };
    const gatedManifests: Manifest[] = [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "staffOnly3" },
        spec: {
          surface: "public",
          from: "posts",
          requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
        },
      },
    ];
    const db = new InMemoryDatabase();
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan(gatedManifests),
      siteDefaults: { locales: ["en"] },
      bindings: { db, adminAssets: new StubAssetServer() },
      auth: customerAuth,
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);
    const res = await app.request("/api/views/staffOnly3");
    expect(res.status).toBe(403);
    const body = await res.json() as { diagnostic?: { code: string } };
    expect(body.diagnostic?.code).toBe("AUTH_DENIED");
  });

  it("authenticates configured OAuth bearer tokens on Views and enforces scope predicates", async () => {
    let scopes: readonly string[] = ["reports:read"];
    let verifyCalls = 0;
    const bearerAuth: Auth = {
      ...stubAuth,
      verifyOAuthAccessToken: async () => {
        verifyCalls++;
        return {
          ok: true,
          userId: "user-1",
          clientId: "client-1",
          credentialId: "jti-1",
          scopes,
        };
      },
    };
    const gatedManifests: Manifest[] = [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "scopedReport" },
        spec: {
          surface: "public",
          from: "posts",
          requires: {
            auth: {
              all: ["ctx.auth", { "ctx.auth.scope": "reports:read" }],
            },
          },
        },
      },
    ];
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan(gatedManifests),
      siteDefaults: { locales: ["en"] },
      bindings: {
        db: new InMemoryDatabase(),
        adminAssets: new StubAssetServer(),
      },
      auth: bearerAuth,
      jwtBearer: { audience: "https://api.example.test" },
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);
    const request = () =>
      app.request("/api/views/scopedReport", {
        headers: { authorization: "Bearer header.payload.signature" },
      });
    expect((await request()).status).toBe(200);
    expect(verifyCalls).toBe(1);
    scopes = [];
    expect((await request()).status).toBe(403);
    expect(verifyCalls).toBe(2);
  });

  it("auth gate runs BEFORE param coercion — anonymous probe doesn't leak the param contract (#210 PR13 CX2)", async () => {
    // Pre-PR13: a View with required params would 400 with "missing
    // locale param" for an anonymous probe, leaking the protected
    // View's parameter contract. Post-PR13: the auth gate fires
    // first → 401 UNAUTHENTICATED with no params shape disclosure.
    const gatedManifests: Manifest[] = [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "staffOnlyWithParams" },
        spec: {
          surface: "public",
          from: "posts",
          requires: { auth: { all: ["ctx.user"] } },
          params: {
            type: "object",
            properties: { secretKey: { type: "string" } },
            required: ["secretKey"],
          },
          filter: { eq: { field: "slug", value: { $param: "secretKey" } } },
        },
      },
    ];
    const db = new InMemoryDatabase();
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan(gatedManifests),
      siteDefaults: { locales: ["en"] },
      bindings: { db, adminAssets: new StubAssetServer() },
      auth: stubAuth,
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);
    // Anonymous probe with NO query params — would have 400'd on
    // missing `secretKey` before the fix.
    const res = await app.request("/api/views/staffOnlyWithParams");
    expect(res.status).toBe(401);
    const body = await res.json() as { diagnostic?: { code: string; message?: string } };
    expect(body.diagnostic?.code).toBe("UNAUTHENTICATED");
    // The diagnostic must not mention the param name.
    expect(body.diagnostic?.message ?? "").not.toContain("secretKey");
  });

  it("STAFF SURFACE (#433): a surface:staff View is unmounted at /api/views/<name> (404)", async () => {
    const h = staffHarness();
    const res = await h.app.request("/api/views/ordersRecent");
    expect(res.status).toBe(404);
  });

  it("STAFF SURFACE (#433): a public View still serves at /api/views/<name>", async () => {
    const h = staffHarness((db) => {
      db.entries.set("p1", row("p1", { slug: "a", locale: "en" }));
    });
    const res = await h.app.request("/api/views/postsPublished");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("auth predicates evaluated BEFORE param coercion — wrong-role user doesn't leak param contract (codex follow-up)", async () => {
    // A logged-in user without the required staff role hitting a
    // staff-gated View with required params must get 403 AUTH_DENIED,
    // not 400 leaking the View's parameter shape. The first PR13
    // commit only caught no-session; an authenticated wrong-role
    // user still slipped through to coerceViewParams.
    const customerAuth: Auth = {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        session: { id: "s", userId: "u", expiresAt: new Date(Date.now() + 60_000) },
        user: { id: "u", email: "x@y.z", name: "Customer", role: null, githubLogin: null },
      }),
      getUserRole: async () => null,
      methods: [],
    };
    const gatedManifests: Manifest[] = [
      ...manifests(),
      {
        apiVersion: "cms.mantle.aotter.net/v1",
        kind: "View",
        metadata: { name: "staffParamsLeak" },
        spec: {
          surface: "public",
          from: "posts",
          requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
          params: {
            type: "object",
            properties: { secretKey: { type: "string" } },
            required: ["secretKey"],
          },
          filter: { eq: { field: "slug", value: { $param: "secretKey" } } },
        },
      },
    ];
    const db = new InMemoryDatabase();
    const ref = createMantleRuntimeRef({
      plan: compileTestPlan(gatedManifests),
      siteDefaults: { locales: ["en"] },
      bindings: { db, adminAssets: new StubAssetServer() },
      auth: customerAuth,
    });
    const app = new Hono();
    mountTestEndpoints(app, ref);
    const res = await app.request("/api/views/staffParamsLeak");
    expect(res.status).toBe(403);
    const body = await res.json() as { diagnostic?: { code: string; message?: string } };
    expect(body.diagnostic?.code).toBe("AUTH_DENIED");
    expect(body.diagnostic?.message ?? "").not.toContain("secretKey");
  });
});

describe("GET /admin/api/views/<name> — staff surface (#433)", () => {
  it("serves a staff View at the admin path with a staff session (200)", async () => {
    const h = staffHarness((db) => {
      db.entries.set("p1", row("p1", { slug: "a", locale: "en" }));
      db.entries.set("p2", row("p2", { slug: "b", locale: "zh-TW" }));
    });
    const res = await h.app.request("/admin/api/views/ordersRecent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { rows: unknown[]; page: number; show: number; hasMore: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data.rows).toHaveLength(2);
  });

  it("returns 401 at the admin path without a session", async () => {
    const h = staffHarness(undefined, stubAuth);
    const res = await h.app.request("/admin/api/views/ordersRecent");
    expect(res.status).toBe(401);
  });

  it("does NOT mount the staff View at the public path (404)", async () => {
    const h = staffHarness();
    const res = await h.app.request("/api/views/ordersRecent");
    expect(res.status).toBe(404);
  });

  it("applies declared Admin search and exact filters before pagination", async () => {
    const h = staffHarness((db) => {
      db.entries.set("p1", row("p1", { slug: "green-tea", locale: "en" }));
      db.entries.set("p2", row("p2", { slug: "green-tea", locale: "zh-TW" }));
      db.entries.set("p3", row("p3", { slug: "cake", locale: "en" }));
    });
    const res = await h.app.request(
      "/admin/api/views/ordersRecent?search=tea&filter.locale=en&show=1",
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { rows: Array<{ id: string }> } };
    expect(body.data.rows.map((item) => item.id)).toEqual(["p1"]);
  });

  it("exports every row matching the active View search and filters", async () => {
    const h = staffHarness((db) => {
      db.entries.set("p1", row("p1", { slug: "green-tea", locale: "en" }));
      db.entries.set("p2", row("p2", { slug: "green-tea", locale: "zh-TW" }));
      db.entries.set("p3", row("p3", { slug: "cake", locale: "en" }));
    });
    const res = await h.app.request(
      "/admin/api/views/ordersRecent/export?search=tea&filter.locale=en",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="ordersRecent.csv"',
    );
    const text = await res.text();
    expect(text.trim().split("\r\n")).toEqual([
      "id,slug,locale",
      "p1,green-tea,en",
    ]);
  });

  it("streams View export pages instead of collecting the whole report", async () => {
    const h = staffHarness((db) => {
      for (let i = 0; i < 55; i++) {
        db.entries.set(`p${i}`, row(`p${i}`, { slug: `item-${i}`, locale: "en" }));
      }
    });
    const viewQueries = () => h.db.executions.filter(({ sql }) =>
      sql.startsWith("SELECT") && sql.includes("FROM entries WHERE collection = ?")
    ).length;
    const before = viewQueries();
    const res = await h.app.request("/admin/api/views/ordersRecent/export");
    expect(viewQueries() - before).toBe(1);
    expect((await res.text()).trim().split("\r\n")).toHaveLength(56);
    expect(viewQueries() - before).toBe(2);
  });
});

describe("GET /admin/api/views-manifest — staff-only filter (#433)", () => {
  it("lists ONLY surface:staff Views (public storefront Views excluded)", async () => {
    const h = staffHarness();
    const res = await h.app.request("/admin/api/views-manifest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: Array<{ name: string }> };
    const names = body.views.map((v) => v.name).sort();
    // Base fixture declares public Views `postsPublished` + `postsByLocale`
    // (default surface); only the staff Views `ordersRecent` +
    // `ordersArchive` must appear.
    expect(names).toEqual(["ordersArchive", "ordersRecent"]);
  });

  it("surfaces View.spec.title (#443) as raw LocalizedText, unresolved", async () => {
    const h = staffHarness();
    const res = await h.app.request("/admin/api/views-manifest");
    const body = (await res.json()) as { views: Array<{ name: string; title: unknown }> };
    const ordersRecent = body.views.find((v) => v.name === "ordersRecent");
    expect(ordersRecent?.title).toEqual({ en: "Recent Orders", "zh-TW": "最新訂單" });
  });

  it("surfaces the validated Admin list query declaration", async () => {
    const h = staffHarness();
    const res = await h.app.request("/admin/api/views-manifest");
    const body = await res.json() as { views: Array<{ name: string; list: unknown }> };
    expect(body.views.find((view) => view.name === "ordersRecent")?.list).toEqual({
      columns: ["id", "slug", "locale"],
      searchFields: ["slug"],
      filterFields: ["locale"],
    });
  });

  it("falls back to null when a View has no title (#443)", async () => {
    const h = staffHarness();
    const res = await h.app.request("/admin/api/views-manifest");
    const body = (await res.json()) as { views: Array<{ name: string; title: unknown }> };
    const ordersArchive = body.views.find((v) => v.name === "ordersArchive");
    expect(ordersArchive?.title).toBeNull();
  });
});
