import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, type StaffRole } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";
import { createAdminSurface, encodeMemberCursor, type AdminAssets, type AdminIdentity } from "../../src/admin/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: { en: Posts, zh-TW: 文章 }
  lifecycle: operational
  uiSchema: { list: { primaryField: title, columns: [sortKey, note] } }
  uniqueIndexes: [[slug]]
  indexes: [[sortKey], [note]]
  schema:
    type: object
    required: [slug, sortKey]
    properties:
      slug: { type: string }
      sortKey: { type: integer }
      title: { type: string }
      note: { type: string }
      cover: { type: string, x-mcp-hint: media-image }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: retitle }
spec:
  title: Retitle
  input: { type: object, required: [id, title], properties: { id: { type: string }, title: { type: string } } }
  output: { type: object, required: [results] }
  target: { schema: posts, id: id }
  handler: { sql: "UPDATE posts SET title = input.title WHERE id = input.id RETURNING title" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: purge }
spec:
  requires: { auth: { all: [{ ctx.staff: [owner] }] } }
  input: { type: object }
  output: { type: object, required: [results] }
  handler: { sql: "DELETE FROM posts WHERE note = 'purge' RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: public-only }
spec:
  input: { type: object }
  output: { type: object, required: [results] }
  handler: { sql: "DELETE FROM posts WHERE note = 'never' RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: t-retitle }
spec: { source: { kind: mcp, surface: staff }, target: { procedure: retitle } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: t-purge }
spec: { source: { kind: mcp, surface: staff }, target: { procedure: purge } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: t-public }
spec: { source: { kind: mcp, surface: public }, target: { procedure: public-only } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: all-posts }
spec:
  surface: staff
  uiSchema: { list: { columns: [slug] } }
  input: { type: object, properties: { min: { type: integer } } }
  sql: "SELECT id, slug, sortKey FROM posts WHERE sortKey >= coalesce(input.min, 0) ORDER BY sortKey"
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: owner-posts }
spec: { surface: staff, requires: { auth: { all: [{ ctx.staff: [owner] }] } }, sql: "SELECT id FROM posts ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: hidden }
spec: { surface: internal, sql: "SELECT id FROM posts ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: pub }
spec: { surface: public, sql: "SELECT id FROM posts ORDER BY id" }
`;

const staff = (subject: string, role: StaffRole | null): Caller => ({ kind: "user", subject, role, scopes: [], credential: "session", credentialId: null, clientId: null });
const owner = staff("u-owner", "owner");
const editor = staff("u-editor", "editor");
const contributor = staff("u-contrib", "contributor");
const anon: Caller = { kind: "anonymous" };

const calls: unknown[][] = [];
const identity: AdminIdentity = {
  directory: {
    getUser: async (id) => (id === "u-owner" ? { id, email: "o@x.test", name: "Olive", role: "owner", githubLogin: null, emailVerified: true, createdAt: new Date(0), image: "https://x.test/o.png" } : null),
    listUsers: async () => [{ id: "u-owner", email: "o@x.test", name: "Olive", role: "owner", githubLogin: null, emailVerified: true, createdAt: new Date(0) }],
    listMembers: async (args) => { calls.push(["listMembers", args]); return { items: [], previousCursor: null, nextCursor: null }; },
  },
  roles: {
    setUserRole: async (id, role) => { calls.push(["setUserRole", id, role]); return id !== "ghost"; },
    inviteUser: async (email) => (email === "o@x.test" ? { kind: "exists", id: "u-owner" } : email === "e@x.test" ? { kind: "exists", id: "u-editor" } : { kind: "created", id: "u-new" }),
    revokeInvite: async (id) => id === "u-new",
  },
};

const assets: AdminAssets = (path) =>
  path === "index.html" ? new Response("<!doctype html><div id=root></div>", { headers: { "content-type": "text/html; charset=utf-8" } })
  : path === "assets/app.js" ? new Response("boot()", { headers: { "content-type": "text/javascript" } })
  : null;

let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:admin", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1) });
  await rt.store.write([1, 2, 3, 4, 5].map((n) => ({ insert: "posts", values: { slug: `p${n}`, sortKey: n, title: `t${n}` } })));
}, 60_000);
afterAll(() => d1.dispose());

const call = async (method: string, path: string, caller: Caller, body?: unknown, opts: { identity?: AdminIdentity | null } = {}) => {
  const surface = createAdminSurface(rt, { basePath: "/admin", ...(opts.identity === null ? {} : { identity: opts.identity ?? identity }), assets });
  const res = await surface(new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), caller);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};

describe("Admin surface: the staff gate", () => {
  it("anonymous is 401 and a caller without a staff role is 403 on every API route, known or not", async () => {
    for (const path of ["/admin/api/me", "/admin/api/staff", "/admin/api/nope"]) {
      expect((await call("GET", path, anon)).status).toBe(401);
      expect((await call("GET", path, staff("m1", null))).status).toBe(403);
      expect((await call("GET", path, { kind: "system", reason: "x" })).status).toBe(403);
    }
  });

  it("a role below the route's minimum is 403 and names the minimum role", async () => {
    const matrix: [string, string, Caller, number, string?][] = [
      ["GET", "/admin/api/staff", editor, 403, "owner"],
      ["GET", "/admin/api/staff", owner, 200],
      ["GET", "/admin/api/members", contributor, 403, "editor"],
      ["GET", "/admin/api/members", editor, 200],
      ["PATCH", "/admin/api/staff/u-new/role", editor, 403, "owner"],
      ["POST", "/admin/api/staff/invitations", editor, 403, "owner"],
      ["DELETE", "/admin/api/staff/invitations/u-new", contributor, 403, "owner"],
      ["GET", "/admin/api/me", contributor, 200],
    ];
    for (const [method, path, caller, status, minimumRole] of matrix) {
      const r = await call(method, path, caller, method === "PATCH" ? { role: "editor" } : undefined);
      expect([method, path, r.status]).toEqual([method, path, status]);
      if (minimumRole) expect(r.body).toMatchObject({ error: { code: "AUTH_DENIED" }, minimumRole });
    }
  });

  it("answers the API with no-store and an unknown API path as JSON 404, never the shell", async () => {
    const r = await call("GET", "/admin/api/nope", owner);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
    expect((await call("GET", "/admin/api/me", owner)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("Admin surface: reads", () => {
  it("/me joins the caller with the directory, and has null fields without one", async () => {
    expect((await call("GET", "/admin/api/me", owner)).body).toEqual({ userId: "u-owner", role: "owner", login: "Olive", image: "https://x.test/o.png" });
    expect((await call("GET", "/admin/api/me", editor, undefined, { identity: null })).body).toEqual({ userId: "u-editor", role: "editor", login: null, image: null });
  });

  it("/collections projects the plan: declared names, media fields, and sortable fields in their declared case", async () => {
    const [posts] = (await call("GET", "/admin/api/collections", contributor)).body.collections;
    expect(posts).toMatchObject({
      name: "posts", title: { en: "Posts", "zh-TW": "文章" }, lifecycle: "operational", localized: false, translates: null, parent: null,
      mediaFields: [{ name: "cover", hint: "media-image" }], sortableFields: ["slug", "sortKey"],
      list: { primaryField: "title", columns: ["sortKey", "note"] }, filter: null, nav: null,
    });
  });

  it("lists staff Views the caller passes, never an internal or public one", async () => {
    const names = async (c: Caller) => (await call("GET", "/admin/api/views-manifest", c)).body.views.map((v: any) => v.name);
    expect(await names(owner)).toEqual(["all-posts", "owner-posts"]);
    expect(await names(editor)).toEqual(["all-posts"]);
    expect((await call("GET", "/admin/api/views-manifest", owner)).body.views[0]).toMatchObject({ list: { columns: ["slug"], searchFields: [], filterFields: [] }, input: { properties: { min: { type: "integer" } } } });
  });

  it("pages a staff View by limit and cursor, coerces its input, and serves no internal or public View", async () => {
    const p1 = await call("GET", "/admin/api/views/all-posts?min=2&limit=2", contributor);
    expect(p1.body.rows.map((r: any) => r.slug)).toEqual(["p2", "p3"]);
    const p2 = await call("GET", `/admin/api/views/all-posts?min=2&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, contributor);
    expect(p2.body.rows.map((r: any) => r.slug)).toEqual(["p4", "p5"]);
    expect((await call("GET", "/admin/api/views/all-posts?min=abc", contributor)).status).toBe(400);
    expect((await call("GET", "/admin/api/views/hidden", owner)).status).toBe(404);
    expect((await call("GET", "/admin/api/views/pub", owner)).status).toBe(404);
  });

  it("bootstrap folds me, collections, operations and views into one answer", async () => {
    const b = (await call("GET", "/admin/api/bootstrap", editor)).body;
    expect(Object.keys(b).sort()).toEqual(["collections", "me", "operations", "views"]);
    expect(b.me.userId).toBe("u-editor");
  });
});

describe("Admin surface: operations", () => {
  it("lists staff mcp Procedures the caller passes, with the interaction from the target", async () => {
    const ops = async (c: Caller) => (await call("GET", "/admin/api/operations", c)).body.operations;
    expect((await ops(owner)).map((o: any) => o.name).sort()).toEqual(["purge", "retitle"]);
    expect(await ops(editor)).toEqual([{ name: "retitle", title: "Retitle", description: null, input: expect.any(Object), uiSchema: null, interactions: [{ collection: "posts", bind: [{ input: "id", field: "id" }], mutates: true }] }]);
  });

  it("runs a visible operation; an invisible or non-staff one is 404, not 403", async () => {
    const [row] = (await rt.store.select({ from: "posts", where: { slug: "p1" } })).rows;
    const r = await call("POST", "/admin/api/operations/retitle", contributor, { id: row!["id"], title: "renamed" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, output: { results: [[{ title: "renamed" }]] } } });
    expect((await call("POST", "/admin/api/operations/purge", editor, {})).status).toBe(404);
    expect((await call("POST", "/admin/api/operations/public-only", owner, {})).status).toBe(404);
    expect((await call("POST", "/admin/api/operations/purge", owner, {})).status).toBe(200);
    expect((await call("POST", "/admin/api/operations/retitle", owner, { id: 5 })).status).toBe(400);
  });
});

describe("Admin surface: staff and members", () => {
  it("hides the routes of a missing facet", async () => {
    const onlyDirectory: AdminIdentity = { directory: identity.directory! };
    const onlyRoles: AdminIdentity = { roles: identity.roles! };
    expect((await call("GET", "/admin/api/staff", owner, undefined, { identity: onlyRoles })).status).toBe(404);
    expect((await call("GET", "/admin/api/members", owner, undefined, { identity: onlyRoles })).status).toBe(404);
    expect((await call("PATCH", "/admin/api/staff/u-new/role", owner, { role: "editor" }, { identity: onlyDirectory })).status).toBe(404);
    expect((await call("POST", "/admin/api/staff/invitations", owner, { email: "n@x.test", role: "editor" }, { identity: onlyDirectory })).status).toBe(404);
    expect((await call("DELETE", "/admin/api/staff/invitations/u-new", owner, undefined, { identity: null })).status).toBe(404);
  });

  it("lists staff and pages members with a checked cursor", async () => {
    expect((await call("GET", "/admin/api/staff", owner)).body.users[0]).toMatchObject({ id: "u-owner" });
    const cursor = encodeMemberCursor("2026-01-01T00:00:00.000Z", "m9");
    expect((await call("GET", `/admin/api/members?limit=10&search=%20ann%20&cursor=${encodeURIComponent(cursor)}&cursor_direction=backward`, editor)).body).toEqual({ items: [], previous_cursor: null, next_cursor: null });
    expect(calls.at(-1)).toEqual(["listMembers", { limit: 10, search: "ann", cursor, cursorDirection: "backward" }]);
    for (const q of ["limit=0", "limit=101", "cursor=bogus", `search=${"a".repeat(201)}`]) expect((await call("GET", `/admin/api/members?${q}`, editor)).status).toBe(400);
  });

  it("changes a role, but an owner cannot change their own, by id or by inviting their own email", async () => {
    expect((await call("PATCH", "/admin/api/staff/u-editor/role", owner, { role: null })).body).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(["setUserRole", "u-editor", null]);
    expect((await call("PATCH", "/admin/api/staff/u-owner/role", owner, { role: "editor" })).status).toBe(403);
    expect((await call("POST", "/admin/api/staff/invitations", owner, { email: "o@x.test", role: "editor" })).status).toBe(403);
    expect((await call("PATCH", "/admin/api/staff/ghost/role", owner, { role: "editor" })).status).toBe(404);
    expect((await call("PATCH", "/admin/api/staff/u-editor/role", owner, { role: "admin" })).status).toBe(400);
  });

  it("invites (re-roling an existing user) and revokes only a never-used invitation", async () => {
    expect((await call("POST", "/admin/api/staff/invitations", owner, { email: " N@x.test ", role: "editor" })).body).toEqual({ ok: true, userId: "u-new", emailSent: false });
    expect((await call("POST", "/admin/api/staff/invitations", owner, { email: "e@x.test", role: "contributor" })).body.userId).toBe("u-editor");
    expect(calls.at(-1)).toEqual(["setUserRole", "u-editor", "contributor"]);
    expect((await call("POST", "/admin/api/staff/invitations", owner, { email: "nope", role: "editor" })).status).toBe(400);
    expect((await call("DELETE", "/admin/api/staff/invitations/u-new", owner)).body).toEqual({ ok: true });
    expect((await call("DELETE", "/admin/api/staff/invitations/u-editor", owner)).status).toBe(409);
  });
});

describe("Admin surface: the SPA shell", () => {
  it("serves the shell ungated for every app path, with frame-ancestors 'none' and no-store, and files as given", async () => {
    for (const path of ["/admin", "/admin/", "/admin/c/posts", "/admin/sign-in"]) {
      const r = await call("GET", path, anon);
      expect([path, r.status, r.body]).toEqual([path, 200, "<!doctype html><div id=root></div>"]);
      expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
    const js = await call("GET", "/admin/assets/app.js", anon);
    expect([js.status, js.body, js.headers.get("content-security-policy")]).toEqual([200, "boot()", null]);
    expect((await call("GET", "/admin/assets/missing.js", anon)).status).toBe(404);
    expect((await call("POST", "/admin/c/posts", owner)).status).toBe(404);
    expect((await call("GET", "/elsewhere", owner)).status).toBe(404);
    expect((await call("GET", "/administrator", owner)).status).toBe(404);
  });

  it("has no shell without assets", async () => {
    const r = await createAdminSurface(rt, { basePath: "/admin" })(new Request("http://x/admin"), owner);
    expect(r.status).toBe(404);
  });
});
