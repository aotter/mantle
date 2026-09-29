import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/core/sql/adapter.js";
import { createRestSurface } from "../../src/web/index.js";

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
`;

const user = (subject: string): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
let rt: MantleRuntime;
let d1: LocalD1;
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:rest", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(d1) });
}, 60_000);
afterAll(() => d1.dispose());

const api = createRestSurface;
const call = async (method: string, path: string, caller: Caller, body?: unknown, who = "http://x") => {
  const res = await api(rt, { basePath: "/api" })(new Request(`${who}${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), caller);
  return { status: res.status, body: (await res.json()) as any };
};

describe("REST surface", () => {
  it("runs an HTTP Trigger with the JSON body, and binds path params to the input by their declared type", async () => {
    const a = await call("POST", "/api/notes", user("o1"), { title: "hello", rank: 2 });
    expect(a).toMatchObject({ status: 200, body: { results: [[{ title: "hello", rank: 2 }]] } });
    const id = a.body.results[0][0].id;
    expect((await call("PATCH", `/api/notes/${id}/rank`, user("o1"), { rank: 9 })).body).toEqual({ results: [[{ id, rank: 9 }]] });
    expect((await call("PATCH", `/api/notes/${id}/rank`, user("o2"), { rank: 1 })).status).toBe(409); // another owner's row is a missing row
  });

  it("serves a public View with coerced query params and one opaque cursor; an internal View is not routed", async () => {
    for (const [title, rank] of [["b", 5], ["c", 6], ["d", 7]]) await call("POST", "/api/notes", user("o3"), { title, rank });
    const p1 = await call("GET", "/api/views/my-notes?min=5&limit=2", user("o3"));
    expect(p1.body.rows.map((r: any) => r.title)).toEqual(["b", "c"]);
    const p2 = await call("GET", `/api/views/my-notes?min=5&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, user("o3"));
    expect(p2.body).toMatchObject({ rows: [{ title: "d" }] });
    expect(p2.body.nextCursor).toBeUndefined();
    expect((await call("GET", "/api/views/hidden", user("o3"))).status).toBe(404);
  });

  it("answers with the Diagnostic's status: 401, 400 for input and JSON, 404 for a route, and never leaks internals", async () => {
    expect((await call("POST", "/api/notes", { kind: "anonymous" }, { title: "x" })).status).toBe(401);
    expect((await call("GET", "/api/views/my-notes", { kind: "anonymous" })).status).toBe(401);
    expect((await call("POST", "/api/notes", user("o1"), { title: 5 })).status).toBe(400);
    expect((await call("POST", "/api/notes", user("o1"), "{not json")).status).toBe(400);
    expect((await call("POST", "/api/notes", user("o1"), [1])).status).toBe(400);
    expect((await call("GET", "/api/views/my-notes?min=abc", user("o1"))).status).toBe(400);
    expect((await call("GET", "/api/nope", user("o1"))).status).toBe(404);
    expect((await call("GET", "/elsewhere/notes", user("o1"))).status).toBe(404);
    expect((await call("PATCH", "/api/notes/x/rank", user("o1"), { rank: "high" })).status).toBe(400);
  });
});
