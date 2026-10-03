import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, type StaffRole } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createAdminSurface } from "../../src/admin/index.js";
import { createMcpSurface } from "../../src/mcp/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: operational
  checks: ["slug <> ''"]
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
  requires: { auth: { all: [ctx.user] } }
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

const admin = () => createAdminSurface(rt, { basePath: "/admin" });
const get = async (path: string, caller: Caller) => {
  const res = await admin()(new Request(`http://x${path}`), caller);
  return { status: res.status, body: await res.json() as any };
};
// the service's own staff MCP mount, for a client with a token
const rpc = async (caller: Caller, method: string, params: unknown = {}) => {
  const res = await createMcpSurface(rt, { basePath: "/mcp/staff", surface: "staff" })(new Request("http://x/mcp/staff", { method: "POST", headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), caller);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, data: line ? JSON.parse(line.slice(5)) : text ? JSON.parse(text) : null };
};

describe("Admin: WebMCP's staff tools", () => {
  it("Admin answers no MCP itself: the browser's tools run on Admin's own routes", async () => {
    expect((await get("/admin/api/mcp", user("owner"))).status).toBe(404);
  });

  it("the staff MCP mount answers staff only: anonymous 401, no role 403", async () => {
    expect((await rpc({ kind: "anonymous" }, "tools/list")).status).toBe(401);
    expect((await rpc(user(null), "tools/list")).status).toBe(403);
    expect((await rpc(user("contributor"), "tools/list")).data.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["all_posts", "picker", "purge", "retitle"]);
  });

  it("/webmcp publishes exactly what the staff MCP surface lists", async () => {
    const listed = (await rpc(user("editor"), "tools/list")).data.result.tools;
    const { status, body } = await get("/admin/api/webmcp", user("editor"));
    expect(status).toBe(200);
    expect(body.tools).toEqual(listed);
  });

  it("routes come only from a Procedure's target Schema and from Views", async () => {
    const { body } = await get("/admin/api/webmcp", user("contributor"));
    expect(body.routes).toEqual({ retitle: { path: "/admin/c/posts", entry: true }, all_posts: { path: "/admin/views/all-posts" }, picker: { path: "/admin/views/picker" } });
    // bootstrap carries the same catalog
    expect((await get("/admin/api/bootstrap", user("contributor"))).body.webmcp).toEqual(body);
  });

  const call = async (name: string, input: unknown, caller: Caller = user("contributor")) => {
    const res = await admin()(new Request(`http://x/admin/api/webmcp/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), caller);
    return { status: res.status, body: await res.json() as any };
  };

  it("a tool call on Admin's tool route answers what the staff MCP surface answers, paging included", async () => {
    for (const [name, input] of [["all_posts", { limit: 1 }], ["purge", {}]] as const) {
      const tool = (await rpc(user("contributor"), "tools/call", { name, arguments: input })).data.result.structuredContent;
      expect((await call(name, input)).body).toEqual({ output: tool });
    }
  });

  it("a tool call is the session's: an unknown tool is 404 and a token is refused", async () => {
    expect((await call("nope", {})).status).toBe(404);
    expect((await call("all_posts", {}, user("owner", "oauth"))).status).toBe(403);
  });
});

describe("Admin: developer console and statistics", () => {
  it("the developer console is the owner's", async () => {
    const r = await get("/admin/api/developer-console", user("editor"));
    expect(r.status).toBe(403);
    expect(r.body.minimumRole).toBe("owner");
  });

  it("projects the plan as the console reads it: SQL as authored, the graph from the IR, interfaces, schedules and TTL, no observed run", async () => {
    const { status, body } = await get("/admin/api/developer-console", user("owner"));
    expect(status).toBe(200);
    expect(body.dataModel.schemas.map((s: { name: string }) => s.name)).toEqual(["posts", "visits"]);
    expect(body.dataModel.views.map((v: { name: string }) => v.name)).toEqual(["all-posts", "picker", "pub"]);
    expect(body.dataModel.views[0]).toMatchObject({ surface: "staff", query: { kind: "sql", statement: "SELECT id, slug FROM posts ORDER BY slug" }, authorization: [], guard: null });
    expect(JSON.stringify(body)).not.toMatch(/SelectStmt|A_Expr/); // the IR (a View's, a check's) stays on the server
    const procs = Object.fromEntries(body.logic.procedures.map((p: { name: string }) => [p.name, p]));
    expect(procs.retitle.handler).toMatchObject({ kind: "sql", statement: "UPDATE posts SET title = input.title WHERE id = input.id RETURNING title", flow: [{ index: 0, operation: "UPDATE", table: "posts", mode: "row", reads: [], writes: ["posts"], returns: ["title"], filter: "id = input.id", cases: [] }] });
    expect(procs.nightly.handler).toEqual({ kind: "ref", ref: "nightly" });
    expect(body.logic.triggers).toContainEqual(expect.objectContaining({ name: "nightly-run", target: "nightly", audience: "system", source: { kind: "schedule", cron: "0 3 * * *" } }));
    expect(body.logic.triggers).toContainEqual(expect.objectContaining({ name: "t-retitle", target: "retitle", audience: "staff" }));
    const edges = body.graph.relations.map((r: { kind: string; sourceId: string; targetId: string }) => `${r.kind} ${r.sourceId} ${r.targetId}`);
    // read from the IR: a View's sources, a Procedure's writes (the DELETE too); a ref handler's declared nothing
    expect(edges).toEqual(expect.arrayContaining(["view-source View:all-posts Schema:posts", "procedure-schema Procedure:retitle Schema:posts", "procedure-schema Procedure:purge Schema:posts", "trigger-target Trigger:nightly-run Procedure:nightly"]));
    expect(edges.filter((e: string) => e.startsWith("procedure-schema Procedure:nightly"))).toEqual([]);
    expect(body.graph.atoms.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(["Schema:posts", "View:all-posts", "Procedure:retitle", "Trigger:nightly-run"]));
    expect(body.interfaces.callable).toContainEqual(expect.objectContaining({ kind: "procedure", name: "purge", target: "purge", surface: "public", trigger: "t-public" }));
    // a staff tool is staff's, whatever else its Procedure requires
    expect(body.interfaces.callable).toContainEqual(expect.objectContaining({ name: "retitle", surface: "staff", audience: "staff" }));
    expect(body.operations).toEqual({
      schedules: [{ id: "nightly-run", procedure: "nightly", cron: "0 3 * * *", enabled: true, registration: "not-observed" }],
      ttlPolicies: [{ schema: "visits", field: "seenAt", expireAfterSeconds: 60, sweepObservation: "unavailable" }],
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
