import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createMcpSurface } from "../../src/mcp/index.js";

const MANIFESTS = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: notes }
spec:
  title: Notes
  lifecycle: operational
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, title: { type: string }, rank: { type: integer } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: add-note }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [title], properties: { title: { type: string }, rank: { type: integer } } }
  output: { type: object, required: [results] }
  handler: { sql: "INSERT INTO notes (title, rank) VALUES (input.title, coalesce(input.rank, 0)) RETURNING id, title, rank" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: rank-note }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, required: [id, rank], properties: { id: { type: string }, rank: { type: integer } } }
  output: { type: object, required: [results] }
  handler: { sql: "UPDATE notes SET rank = input.rank WHERE id = input.id RETURNING id, rank" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: post-note }
spec: { source: { kind: http, method: POST, path: /api/notes }, target: { procedure: add-note } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: rank-it }
spec: { source: { kind: http, method: PATCH, path: "/api/notes/{id}/rank" }, target: { procedure: rank-note } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: a-by-id }
spec: { source: { kind: http, method: POST, path: "/api/notes/{id}" }, target: { procedure: rank-note } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: search-notes }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object }
  output: { type: object, required: [results] }
  handler: { sql: "INSERT INTO notes (title) VALUES ('searched') RETURNING title" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: b-search }
spec: { source: { kind: http, method: POST, path: /api/notes/search }, target: { procedure: search-notes } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: my-notes }
spec:
  surface: public
  requires: { auth: { all: [ctx.user] } }
  input: { type: object, properties: { min: { type: integer } } }
  sql: "SELECT id, title, rank FROM notes WHERE rank >= coalesce(input.min, 0) ORDER BY rank, title"
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: hidden }
spec: { surface: internal, sql: "SELECT id FROM notes ORDER BY id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mcp-add }
spec: { source: { kind: mcp, surface: public }, target: { procedure: add-note } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: staff-wipe }
spec:
  description: Wipe rank
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  input: { type: object }
  output: { type: object, required: [results] }
  handler: { sql: "UPDATE notes SET rank = 0 RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mcp-wipe }
spec: { source: { kind: mcp, surface: staff }, target: { procedure: staff-wipe } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: scoped-add }
spec:
  requires: { auth: { all: [ctx.user, { ctx.auth.scope: "notes:write" }] } }
  input: { type: object, required: [title], properties: { title: { type: string } } }
  output: { type: object, required: [results] }
  handler: { sql: "INSERT INTO notes (title) VALUES (input.title) RETURNING id" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mcp-scoped }
spec: { source: { kind: mcp, surface: public }, target: { procedure: scoped-add } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: ranked }
spec:
  surface: public
  input: { type: object, required: [min], properties: { min: { type: integer } } }
  sql: "SELECT id FROM notes WHERE rank >= input.min ORDER BY id"
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: leaky }
spec:
  input: { type: object }
  output: { type: object, additionalProperties: false, properties: { ok: { type: boolean } } }
  handler: { ref: leak }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: mcp-leaky }
spec: { source: { kind: mcp, surface: public }, target: { procedure: leaky } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: staff-notes }
spec: { surface: staff, description: Every note, sql: "SELECT id, title FROM notes ORDER BY id" }
`;

const user = (subject: string, over: Partial<Extract<Caller, { kind: "user" }>> = {}): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null, ...over });
const anon: Caller = { kind: "anonymous" };
let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:mcp", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: { leak: () => ({ ok: true, secret: "s3cr3t-hash" }) }, storage: sqliteStorage(d1) });
}, 60_000);
afterAll(() => d1.dispose());

const RM = "https://x.test/.well-known/oauth-protected-resource";
const rpc = async (surface: "public" | "staff", caller: Caller, method: string, params: unknown = {}) => {
  const res = await createMcpSurface(rt, { basePath: "/mcp", surface, resourceMetadata: RM })(
    new Request("https://x.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), caller);
  const text = await res.text();
  const data = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:") ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) : text ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, data };
};
const names = async (surface: "public" | "staff", caller: Caller) => ((await rpc(surface, caller, "tools/list")).data.result.tools as { name: string }[]).map((t) => t.name).sort();

describe("MCP surface", () => {
  it("lists only Procedure and View tools of the surface; an internal View and every Schema are absent", async () => {
    expect(await names("public", user("a"))).toEqual(["add_note", "leaky", "my_notes", "ranked", "scoped_add"]);
    expect(await names("staff", user("a", { role: "owner" }))).toEqual(["staff_notes", "staff_wipe"]);
  });

  it("carries the manifest description, the paging inputs and read-only hints", async () => {
    const tools = (await rpc("staff", user("a", { role: "owner" }), "tools/list")).data.result.tools;
    const notes = tools.find((t: any) => t.name === "staff_notes");
    expect(notes).toMatchObject({ description: "Every note", annotations: { readOnlyHint: true } });
    expect(Object.keys(notes.inputSchema.properties)).toEqual(["limit", "cursor"]);
    expect(tools.find((t: any) => t.name === "staff_wipe").description).toBe("Wipe rank");
  });

  it("calls a Procedure and pages a View through the same store", async () => {
    const o = user("m1");
    for (const t of ["a", "b", "c"]) await rpc("public", o, "tools/call", { name: "add_note", arguments: { title: t, rank: 1 } });
    const p1 = (await rpc("public", o, "tools/call", { name: "my_notes", arguments: { limit: 2 } })).data.result.structuredContent;
    expect(p1.rows).toHaveLength(2);
    const p2 = (await rpc("public", o, "tools/call", { name: "my_notes", arguments: { limit: 2, cursor: p1.nextCursor } })).data.result.structuredContent;
    expect(p2.rows).toHaveLength(1);
  });

  it("reports a Diagnostic as an error result, and never as a transport error", async () => {
    const r = (await rpc("public", user("m2"), "tools/call", { name: "add_note", arguments: { title: 5 } })).data.result;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).diagnostics[0].code).toBe("INPUT_VALIDATION_FAILED");
  });

  it("answers an anonymous call to a tool that needs identity with 401 and resource_metadata, before anything runs", async () => {
    const r = await rpc("public", anon, "tools/call", { name: "add_note", arguments: { title: "x" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${RM}"`);
    expect((await d1.all("SELECT count(*) AS c FROM notes WHERE title = 'x'"))[0]).toEqual({ c: 0 });
    // discovery stays open on the public surface
    expect((await rpc("public", anon, "tools/list")).status).toBe(200);
  });

  it("closes the staff surface to anonymous (401) and non-staff (403) callers, for list and call alike", async () => {
    for (const method of ["tools/list", "tools/call"]) {
      const params = method === "tools/call" ? { name: "staff_wipe", arguments: {} } : {};
      expect((await rpc("staff", anon, method, params)).status).toBe(401);
      expect((await rpc("staff", user("m3"), method, params)).status).toBe(403);
    }
    expect((await rpc("staff", user("m3", { role: "editor" }), "tools/call", { name: "staff_wipe", arguments: {} })).status).toBe(200);
  });

  it("does not run a staff tool asked for on the public surface", async () => {
    const r = await rpc("public", user("m4", { role: "owner" }), "tools/call", { name: "staff_wipe", arguments: {} });
    expect(JSON.stringify(r.data)).toMatch(/not found|unknown|Tool/i);
    expect((await d1.all("SELECT count(*) AS c FROM notes WHERE rank = 0 AND owner = 'm4'"))[0]).toEqual({ c: 0 });
  });

  it("asks an OAuth caller for the missing scope (403 insufficient_scope) and leaves a session to the runtime denial", async () => {
    const call = { name: "scoped_add", arguments: { title: "s" } };
    const oauth = await rpc("public", user("m5", { credential: "oauth", scopes: ["openid"] }), "tools/call", call);
    expect(oauth.status).toBe(403);
    expect(oauth.headers.get("www-authenticate")).toBe(`Bearer error="insufficient_scope", scope="openid notes:write", resource_metadata="${RM}"`);
    const session = await rpc("public", user("m5"), "tools/call", call);
    expect(session.data.result.isError).toBe(true);
    expect(JSON.parse(session.data.result.content[0].text).diagnostics[0].code).toBe("AUTH_DENIED");
    expect((await rpc("public", user("m5", { credential: "oauth", scopes: ["notes:write"] }), "tools/call", call)).data.result.isError).toBeUndefined();
  });

  it("checks a View's input against its schema, and reports a wrong limit or cursor instead of dropping it", async () => {
    const o = user("m6");
    const code = async (name: string, args: unknown) => JSON.parse((await rpc("public", o, "tools/call", { name, arguments: args })).data.result.content[0].text).diagnostics?.[0]?.code;
    expect(await code("ranked", {})).toBe("INPUT_VALIDATION_FAILED");
    expect(await code("ranked", { min: "abc" })).toBe("INPUT_VALIDATION_FAILED");
    expect(await code("my_notes", { limit: "2" })).toBe("INPUT_VALIDATION_FAILED");
    expect(await code("my_notes", { cursor: 5 })).toBe("INPUT_VALIDATION_FAILED");
    expect((await rpc("public", o, "tools/call", { name: "ranked", arguments: { min: 0 } })).data.result.isError).toBeUndefined();
  });

  it("never sends handler output that broke its schema to the client", async () => {
    const r = (await rpc("public", user("m7"), "tools/call", { name: "leaky", arguments: {} })).data.result;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("s3cr3t-hash");
    expect(JSON.parse(r.content[0].text).diagnostics[0].code).toBe("OUTPUT_VALIDATION_FAILED");
  });

  it("puts the needed scope in a 401 challenge, and gives a non-staff caller a 403 with no challenge", async () => {
    const r = await rpc("public", anon, "tools/call", { name: "scoped_add", arguments: { title: "s" } });
    expect(r.headers.get("www-authenticate")).toBe(`Bearer scope="notes:write", resource_metadata="${RM}"`);
    expect((await rpc("staff", user("m8"), "tools/list")).headers.get("www-authenticate")).toBeNull();
  });

  it("refuses a whole batch when one call in it needs identity", async () => {
    const res = await createMcpSurface(rt, { basePath: "/mcp", surface: "public" })(new Request("https://x.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_note", arguments: { title: "batch" } } }]) }), anon);
    expect(res.status).toBe(401);
  });

  it("answers a path that is not its own with 404", async () => {
    const res = await createMcpSurface(rt, { basePath: "/mcp", surface: "public" })(new Request("https://x.test/other", { method: "POST" }), anon);
    expect(res.status).toBe(404);
  });
});
