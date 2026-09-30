import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, type StaffRole } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";
import { createAdminSurface } from "../../src/admin/index.js";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { createMcpSurface, type McpApps } from "../../src/mcp/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: operational
  schema: { type: object, required: [slug], properties: { slug: { type: string }, title: { type: string } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: visits }
spec:
  title: Visits
  lifecycle: operational
  ttl: { field: seenAt, expireAfterSeconds: 60 }
  schema: { type: object, properties: { seenAt: { type: string, format: date-time } } }
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
  input: { type: object }
  output: { type: object, required: [results] }
  handler: { sql: "DELETE FROM posts WHERE title = 'purge' RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: nightly }
spec: { input: { type: object }, output: { type: object }, handler: { ref: nightly } }
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
spec: { source: { kind: mcp, surface: public }, target: { procedure: purge } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: nightly-run }
spec: { source: { kind: schedule, cron: "0 3 * * *" }, target: { procedure: nightly } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: all-posts }
spec: { surface: staff, title: { en: All posts, zh-TW: 全部文章 }, sql: "SELECT id, slug FROM posts ORDER BY slug" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: picker }
spec: { surface: staff, sql: "SELECT id FROM posts ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: pub }
spec: { surface: public, sql: "SELECT id FROM posts ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: hidden }
spec: { surface: internal, sql: "SELECT id FROM posts ORDER BY id" }
`;

const user = (role: StaffRole | null, credential: "session" | "oauth" = "session"): Caller => ({ kind: "user", subject: `u-${role}`, role, scopes: [], credential, credentialId: null, clientId: null });
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:admin-mcp", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: { nightly: async () => ({}) }, storage: sqliteStorage(d1), schedules: true });
}, 60_000);
afterAll(() => d1.dispose());

type Mcp = boolean | { locale: string; apps: McpApps };
const admin = (mcp: Mcp = true) => createAdminSurface(rt, { basePath: "/admin", ...(mcp ? { staffMcp: createMcpSurface(rt, { basePath: "/admin/api/mcp", surface: "staff", ...(mcp === true ? {} : mcp) }) } : {}) });
const get = async (path: string, caller: Caller, mcp: Mcp = true) => {
  const res = await admin(mcp)(new Request(`http://x${path}`), caller);
  return { status: res.status, body: await res.json() as any };
};
const rpc = async (caller: Caller, method: string, mcp: Mcp = true, params: unknown = {}) => {
  const res = await admin(mcp)(new Request("http://x/admin/api/mcp", { method: "POST", headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), caller);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, data: line ? JSON.parse(line.slice(5)) : text ? JSON.parse(text) : null };
};

describe("Admin: the staff MCP mount", () => {
  it("answers staff sessions only: anonymous 401, no role 403, a token 403", async () => {
    expect((await rpc({ kind: "anonymous" }, "tools/list")).status).toBe(401);
    expect((await rpc(user(null), "tools/list")).status).toBe(403);
    // Admin acts as the signed-in person; an MCP client with a token uses the service's own staff MCP mount
    expect((await rpc(user("owner", "oauth"), "tools/list")).status).toBe(403);
    const ok = await rpc(user("contributor"), "tools/list");
    expect(ok.status).toBe(200);
    expect(ok.data.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["all_posts", "picker", "purge", "retitle"]);
  });

  it("/webmcp publishes exactly what tools/list lists", async () => {
    const listed = (await rpc(user("editor"), "tools/list")).data.result.tools;
    const { status, body } = await get("/admin/api/webmcp", user("editor"));
    expect(status).toBe(200);
    expect(body.tools).toEqual(listed);
  });

  it("/webmcp is the tools the surface registered: its locale, and app-only tools hidden from a client without MCP Apps", async () => {
    const mcp = { locale: "zh-TW", apps: { resources: [{ uri: "ui://posts", name: "posts", html: "<p></p>", renders: ["retitle"], appOnly: ["picker"] }] } };
    const pick = (ts: { name: string; title?: string }[]) => ts.map(({ name, title }) => ({ name, title }));
    // Admin's page is not an MCP Apps host: it declares capabilities without the UI extension
    const listed = (await rpc(user("editor"), "tools/list", mcp, { _meta: { [CLIENT_CAPABILITIES_META_KEY]: {} } })).data.result.tools;
    const { body } = await get("/admin/api/webmcp", user("editor"), mcp);
    expect(pick(body.tools)).toEqual(pick(listed));
    expect(pick(body.tools)).toContainEqual({ name: "all_posts", title: "全部文章" });
    expect(body.tools.map((t: { name: string }) => t.name)).not.toContain("picker");
    expect(body.routes).not.toHaveProperty("picker");
  });

  it("routes come only from a Procedure's target Schema and from Views", async () => {
    const { body } = await get("/admin/api/webmcp", user("contributor"));
    expect(body.routes).toEqual({ retitle: { path: "/admin/c/posts", entry: true }, all_posts: { path: "/admin/views/all-posts" }, picker: { path: "/admin/views/picker" } });
    // bootstrap carries the same catalog
    expect((await get("/admin/api/bootstrap", user("contributor"))).body.webmcp).toEqual(body);
  });

  it("without a staff MCP surface neither route exists", async () => {
    expect((await get("/admin/api/webmcp", user("owner"), false)).status).toBe(404);
    expect((await rpc(user("owner"), "tools/list", false)).status).toBe(404);
    expect((await get("/admin/api/bootstrap", user("owner"), false)).body.webmcp).toBeNull();
  });
});

describe("Admin: developer console and statistics", () => {
  it("the developer console is the owner's", async () => {
    const r = await get("/admin/api/developer-console", user("editor"));
    expect(r.status).toBe(403);
    expect(r.body.minimumRole).toBe("owner");
  });

  it("projects the plan: IR for Views and inline Procedures, triggers, schedules and TTL, and no observed run", async () => {
    const { status, body } = await get("/admin/api/developer-console", user("owner"));
    expect(status).toBe(200);
    expect(body.dataModel.schemas.map((s: { name: string }) => s.name)).toEqual(["posts", "visits"]);
    expect(body.dataModel.views.map((v: { name: string }) => v.name)).toEqual(["all-posts", "picker", "pub"]);
    const view = body.dataModel.views[0];
    expect(view.sql.stmts).toEqual(rt.plan.views["all-posts"]!.stmts);
    expect(view.sql.stmts[0]).toHaveProperty("SelectStmt");
    const procs = Object.fromEntries(body.logic.procedures.map((p: { name: string }) => [p.name, p]));
    expect(procs.retitle.handler.sql.stmts[0]).toHaveProperty("UpdateStmt");
    expect(procs.retitle.target).toEqual({ schema: "posts", id: "id" });
    expect(procs.nightly.handler).toEqual({ ref: "nightly" });
    expect(body.logic.triggers).toContainEqual({ name: "nightly-run", procedure: "nightly", source: { kind: "schedule", cron: "0 3 * * *" } });
    expect(body.operations).toEqual({
      schedules: [{ id: "nightly-run", procedure: "nightly", cron: "0 3 * * *", enabled: true, registration: "not-observed" }],
      ttlPolicies: [{ schema: "visits", field: "seenAt", seconds: 60, sweepObservation: "unavailable" }],
      observationAvailability: "unavailable", runs: [], latestRuns: [],
    });
  });

  it("statistics: an unknown collection is 404, a known one 501", async () => {
    expect((await get("/admin/api/collections/nope/statistics", user("contributor"))).status).toBe(404);
    const r = await get("/admin/api/collections/posts/statistics?range=7d", user("contributor"));
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe("STATISTICS_UNAVAILABLE");
  });
});
