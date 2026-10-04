// Regressions from the 0.2.x milestone review: each test names the defect it pins.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan } from "../../src/spec/index.js";
import { createMantleRuntime, type Caller, type InvocationCause, type MantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { createAdminSurface } from "../../src/admin/index.js";

const doc = (kind: string, name: string, spec: string) => `apiVersion: cms.mantle.aotter.net/v2\nkind: ${kind}\nmetadata: { name: ${name} }\nspec:\n${spec}`;
const schema = (name: string, props: string, extra = "") =>
  doc("Schema", name, `  title: ${name}\n  lifecycle: operational\n${extra}  schema: { type: object, properties: { ${props} } }\n`);
const view = (name: string, sql: string) => doc("View", name, `  surface: public\n  sql: "${sql}"\n`);
const refProc = (name: string) => doc("Procedure", name, "  input: { type: object }\n  output: { type: object }\n  handler: { ref: " + name + " }\n");
const hook = (name: string, schemaName: string, on: string, target: string) => doc("Trigger", name, `  source: { kind: lifecycle, schema: ${schemaName}, on: [${on}] }\n  target: { procedure: ${target} }\n`);

const MANIFESTS = [
  schema("items", "name: { type: string }, cat: { type: string }, note: { type: string }, stock: { type: integer }"),
  view("unordered", "SELECT id, name FROM items"),
  view("cats", "SELECT DISTINCT cat FROM items"),
  view("total", "SELECT count(*) AS n FROM items"),
  view("bycat", "SELECT cat, count(*) AS n FROM items GROUP BY cat"),
  view("top2", "SELECT id, name FROM items ORDER BY name LIMIT 2"),
  view("byord", "SELECT name, id FROM items ORDER BY 1 DESC"),
  view("bynote", "SELECT id, note FROM items ORDER BY note"),
  view("star-sub", "SELECT * FROM (SELECT id, name FROM items) s ORDER BY s.name"),
  // a Schema whose declared name has capitals: its hooks must still fire
  schema("BlogPost", "name: { type: string }"),
  refProc("deny"), refProc("audit"),
  hook("deny-create", "BlogPost", "before_create", "deny"),
  hook("audit-create", "BlogPost", "after_create", "audit"),
  // an after hook on a Schema whose Procedure statements have no RETURNING
  schema("profiles", "handle: { type: string }, email: { type: string }, views: { type: integer }"),
  doc("Procedure", "bump-views", "  input: { type: object, required: [id], properties: { id: { type: string } } }\n  output: { type: object }\n  handler: { sql: \"UPDATE profiles SET views = views + 1 WHERE id = input.id\" }\n"),
  hook("audit-profile", "profiles", "after_update", "audit"),
  // json columns that hold a string; a default the insert leaves out; a geo field
  doc("Schema", "kinds", "  title: Kinds\n  lifecycle: operational\n  schema:\n    type: object\n    $defs: { Kind: { type: string, enum: [a, b] } }\n    properties: { kind: { $ref: \"#/$defs/Kind\" }, tag: { enum: [x, y] } }\n"),
  doc("Schema", "tasks", "  title: Tasks\n  lifecycle: operational\n  schema:\n    type: object\n    required: [title, priority]\n    properties: { title: { type: string }, priority: { type: integer, default: 3 } }\n"),
  doc("Schema", "places", "  title: Places\n  lifecycle: operational\n  schema:\n    type: object\n    required: [name]\n    properties: { name: { type: string }, loc: { type: object, format: geo, properties: { lat: { type: number }, lng: { type: number } } } }\n"),
  doc("Schema", "articles", "  title: Articles\n  lifecycle: publishing\n  schema:\n    type: object\n    required: [slug, title]\n    properties: { slug: { type: string }, title: { type: string } }\n"),
].join("---\n");

const user = (subject: string, over: Partial<Extract<Caller, { kind: "user" }>> = {}): Caller => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null, ...over });
const http = (id: string): InvocationCause => ({ kind: "http", id });

let rt: MantleRuntime;
let d1: LocalD1;
const calls: string[] = [];
const causes: InvocationCause[] = [];
beforeAll(async () => {
  const res = await compilePlan({ sources: [{ sourceId: "memory:review", text: MANIFESTS }] });
  if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
  d1 = await LocalD1.create();
  rt = await createMantleRuntime({
    plan: res.plan, storage: sqliteStorage(d1),
    handlers: {
      deny: (_i, ctx) => { calls.push("deny"); if ((ctx.cause as { rows?: { name?: string }[] }).rows?.[0]?.name === "blocked") throw new Error("denied"); return {}; },
      audit: (_i, ctx) => { calls.push("audit"); causes.push(ctx.cause); return {}; },
    },
  });
  await rt.store.write(["m", "z", "a", "q"].map((name, i) => ({ insert: "items", values: { name, cat: "x", stock: i, ...(i % 2 ? { note: `n${i}` } : {}) } })));
});
afterAll(() => d1?.dispose());

describe("lifecycle hooks", () => {
  it("fire on a Schema whose declared name has capitals, and a before hook that throws still rejects the write", async () => {
    calls.length = 0;
    await rt.store.write([{ insert: "BlogPost", values: { name: "ok" } }]);
    expect(calls).toEqual(["deny", "audit"]);
    expect((causes.at(-1) as { schema: string }).schema).toBe("BlogPost");
    await expect(rt.store.write([{ insert: "BlogPost", values: { name: "blocked" } }])).rejects.toThrow();
    expect(await d1.all("SELECT name FROM blogpost ORDER BY name")).toEqual([{ name: "ok" }]);
  });

  it("an after hook gets id and version, and a statement without RETURNING still returns no rows to its caller", async () => {
    const [{ id }] = (await rt.store.write([{ insert: "profiles", values: { handle: "alice", email: "alice@secret.example", views: 0 } }])) as [{ id: string }];
    causes.length = 0;
    const out = await rt.invokeProcedure({ procedure: "bump-views", input: { id }, caller: { kind: "anonymous" }, cause: http("bump") });
    expect(out).toEqual({ results: [[]] });
    const rows = (causes[0] as { rows: Record<string, unknown>[] }).rows;
    expect(rows[0]).toMatchObject({ id, version: 2, views: 1 });
  });
});

describe("Store", () => {
  it("writes and reads a string in a json column", async () => {
    await rt.store.write([{ insert: "kinds", values: { kind: "a", tag: "x" } }]);
    expect((await rt.store.select({ from: "kinds", columns: ["kind", "tag"] })).rows).toEqual([{ kind: "a", tag: "x" }]);
  });

  it("fills a JSON Schema default the insert leaves out", async () => {
    await rt.store.write([{ insert: "tasks", values: { title: "t" } }]);
    expect((await rt.store.select({ from: "tasks", columns: ["title", "priority"] })).rows).toEqual([{ title: "t", priority: 3 }]);
  });

  it("writes and reads a geo field as { lat, lng }, and refuses a value out of range", async () => {
    await rt.store.write([{ insert: "places", values: { name: "taipei", loc: { lat: 25.03, lng: 121.56 } } }, { insert: "places", values: { name: "nowhere" } }]);
    const rows = (await rt.store.select({ from: "places", columns: ["name", "loc"], orderBy: { name: "asc" } })).rows;
    expect(rows).toEqual([{ name: "nowhere", loc: null }, { name: "taipei", loc: { lat: 25.03, lng: 121.56 } }]);
    await expect(rt.store.write([{ insert: "places", values: { name: "bad", loc: { lat: 91, lng: 0 } } }])).rejects.toThrow(/lat, lng/);
  });

  it("Admin creates an empty draft in a publishing collection", async () => {
    const editor = user("e1", { role: "editor" });
    const res = await createAdminSurface(rt, { basePath: "/admin" })(new Request("http://x/admin/api/entries", { method: "POST", body: JSON.stringify({ collection: "articles", data: {} }) }), editor);
    expect(res.status).toBe(200);
    expect((await res.json()).entry).toMatchObject({ status: "draft", data: { slug: null, title: null } });
  });
});

describe("View paging", () => {
  const view = (name: string, options = {}) => rt.store.view(name, options);

  it("runs a View without ORDER BY as one page: DISTINCT, an aggregate and a GROUP BY", async () => {
    expect((await view("cats")).rows).toEqual([{ cat: "x" }]);
    expect((await view("total")).rows).toEqual([{ n: 4 }]);
    expect((await view("bycat")).rows).toEqual([{ cat: "x", n: 4 }]);
    expect((await view("unordered")).rows).toHaveLength(4);
    await expect(view("unordered", { limit: 2 })).rejects.toThrow(/no ORDER BY/);
  });

  it("keeps the View's own LIMIT", async () => {
    expect((await view("top2", { limit: 10 })).rows.map((r) => r.name)).toEqual(["a", "m"]);
    const first = await view("top2", { limit: 1 });
    const second = await view("top2", { limit: 1, cursor: first.nextCursor });
    expect([...first.rows, ...second.rows].map((r) => r.name)).toEqual(["a", "m"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("sorts by an ORDER BY position", async () => {
    expect((await view("byord")).rows.map((r) => r.name)).toEqual(["z", "q", "m", "a"]);
  });

  it("pages through NULL sort keys without dropping rows", async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await view("bynote", { limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.rows.map((r) => r.note));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([null, null, "n1", "n3"]);
  });

  it("refuses SELECT * over a FROM subquery instead of returning empty rows", async () => {
    await expect(view("star-sub")).rejects.toThrow(/SELECT \* reads a subquery/);
  });
});

describe("compile and boot", () => {
  it("refuses a bare string compared with a date-time, date or boolean column", async () => {
    const events = schema("events", "name: { type: string }, startsAt: { type: string, format: date-time }, done: { type: boolean }");
    for (const where of ["startsAt > '2020-01-01T00:00:00Z'", "done = 'true'", "created_at > '2020-01-01'"]) {
      const res = await compilePlan({ sources: [{ sourceId: "m", text: `${events}---\n${view("v", `SELECT id FROM events WHERE ${where} ORDER BY id`)}` }] });
      expect(res.ok ? [] : res.diagnostics.map((d) => d.code)).toEqual(["SQL_TYPE"]);
    }
    const cast = await compilePlan({ sources: [{ sourceId: "m", text: `${events}---\n${view("v", "SELECT id FROM events WHERE startsAt > CAST('2020-01-01T00:00:00Z' AS timestamptz) AND done = true ORDER BY id")}` }] });
    expect(cast.ok).toBe(true);
  });

  it("indexes a native column by its physical name, so a later deploy still boots", async () => {
    const db = await LocalD1.create();
    try {
      for (const extra of ["", ", level: { type: string }"]) {
        const res = await compilePlan({ sources: [{ sourceId: "m", text: schema("logs", `msg: { type: string }${extra}`, "  indexes: [[createdAt]]\n") }] });
        if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
        await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(db) });
      }
      expect(await db.all("SELECT ii.name AS col FROM pragma_index_list('logs') il, pragma_index_info(il.name) ii WHERE il.name = '_mantle_ix_logs_0'")).toEqual([{ col: "created_at" }]);
    } finally {
      await db.dispose();
    }
  });

  it("writes the time zone's transitions once, not on every plan change", async () => {
    const db = await LocalD1.create();
    try {
      for (const extra of ["", ", b: { type: string }"]) {
        const res = await compilePlan({ sources: [{ sourceId: "m", text: schema("notes", `a: { type: string }${extra}`) }] });
        if (!res.ok) throw new Error(JSON.stringify(res.diagnostics));
        await createMantleRuntime({ plan: res.plan, handlers: {}, storage: sqliteStorage(db, { timeZone: "Asia/Taipei" }) });
        if (!extra) await db.exec("INSERT INTO _mantle_tz (from_us, offset_us) VALUES (1, 1)"); // a marker a rewrite would remove
      }
      expect(await db.all("SELECT count(*) AS c FROM _mantle_tz WHERE from_us = 1")).toEqual([{ c: 1 }]);
      expect(await db.all("SELECT value FROM _mantle_boot_state WHERE key = 'timezone'")).toEqual([{ value: "Asia/Taipei" }]);
    } finally {
      await db.dispose();
    }
  });
});
