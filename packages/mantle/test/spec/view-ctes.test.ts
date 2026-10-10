// @ts-nocheck native engine cases over deliberately inspectable SQL IR
import { describe, expect, it } from "vitest";
import { LocalD1 } from "../../src/cloudflare/testing/d1.js";
import { compilePlan, compileSql } from "../../src/spec/index.js";
import { relationNames } from "../../src/spec/infrastructure/sql/compileSql.js";
import { createMantleRuntime } from "../../src/core/index.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, site, schemas, caller, runView, runProcedure } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "../postgres/engine.js";
const doc = (kind, name, spec) => `apiVersion: cms.mantle.aotter.net/v2\nkind: ${kind}\nmetadata: { name: ${name} }\nspec:\n${spec}`;
const schema = doc("Schema", "notes", `  title: Notes
  lifecycle: operational
  scope: { owner: auth.uid() }
  schema:
    type: object
    required: [owner]
    properties: { owner: { type: string }, title: { type: string }, due: { type: string, format: date-time } }
  indexes: [[owner, title]]`);
const view = (name, sql, input = "") => doc("View", name, `  surface: internal\n${input}  sql: ${JSON.stringify(sql)}`);
const user = (subject) => ({ kind: "user", subject, role: null, scopes: [], credential: "session", credentialId: null, clientId: null });
const source = (...docs) => ({ sources: [{ sourceId: "memory:cte-regression", text: [schema, ...docs].join("\n---\n") }] });
const documents = [
  view("nested", "SELECT b.id, b.title FROM base_notes b WHERE EXISTS (WITH base_notes AS (SELECT id FROM notes WHERE title = 'same') SELECT id FROM base_notes WHERE id = b.id) ORDER BY b.id"),
  view("page", "SELECT _view_0.id, _view_0.title, _view_0.due, (SELECT count(*) FROM base_notes b WHERE b.title = _view_0.title) AS siblings FROM left_notes _view_0 WHERE _view_0.title <> input.omit ORDER BY _view_0.due DESC, _view_0.id LIMIT 5", "  input: { type: object, required: [omit], properties: { omit: { type: string } } }\n"),
  view("collision", "WITH notes AS (SELECT 'fake' AS id) SELECT b.id, b.title, (SELECT count(*) FROM notes) AS marker FROM base_notes b ORDER BY b.id"),
  view("own-cte", "WITH notes AS (SELECT id, title FROM notes) SELECT notes.id, notes.title FROM notes ORDER BY notes.id"),
  view("renamed-columns", "WITH notes(id, label, deadline) AS (SELECT id, title, due FROM notes) SELECT n.id, n.label, n.deadline FROM notes n ORDER BY n.id"),
  view("first-notes", "SELECT id, title FROM notes ORDER BY title, id LIMIT 2"),
  view("first-twice", "SELECT f.id, (SELECT count(*) FROM first_notes) AS n FROM first_notes f ORDER BY f.id"),
  view("left-notes", "SELECT id, title, due FROM base_notes WHERE title <> 'hidden'"),
  view("base-notes", "SELECT id, title, due FROM notes"),
];
it("resolves dependencies in lexical CTE scope, including siblings and nested WITH", async () => {
  expect([...await relationNames("SELECT a.id FROM a WHERE EXISTS (WITH a AS (SELECT id FROM b) SELECT id FROM a)")].sort()).toEqual(["a", "b"]);
  expect([...await relationNames("WITH a AS (SELECT id FROM a), b AS (SELECT id FROM a) SELECT id FROM b")]).toEqual(["a"]);
  expect([...await relationNames("WITH RECURSIVE a AS (SELECT id FROM a) SELECT id FROM a")]).toEqual([]);
});
for (const engine of ["sqlite", "postgres"]) describe.skipIf(engine === "postgres" && !PG_URL)(`${engine} named View CTEs`, () => {
  it("shares a dependency DAG, preserves lexical binding, row types, scope and all cursor pages", async () => {
    const result = await compilePlan(source(...documents), engine === "postgres" ? pgCompile : undefined);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const plan = result.plan, select = plan.views.page.stmts[0].SelectStmt;
    expect(select.withClause.ctes).toHaveLength(2);
    expect(JSON.stringify(select).match(/"relname":"notes"/g)).toHaveLength(1);
    expect(plan.views["renamed-columns"].columns.deadline).toEqual({ schema: "notes", field: "due" });
    expect(plan.views.page.columns.due).toEqual({ schema: "notes", field: "due" });
    expect(JSON.stringify(select)).not.toContain('"mantle":"view"');
    const native = engine === "postgres" ? await freshSchema() : await LocalD1.create();
    try {
      const rt = await createMantleRuntime({ plan, handlers: {}, storage: engine === "postgres" ? postgresStorage({ connect: native.connect }) : sqliteStorage(native) });
      for (let i = 0; i < 8; i++) await rt.store.as(user("a")).write([{ insert: "notes", values: { title: i < 6 ? "same" : "hidden", ...(i === 0 ? {} : { due: "2026-01-02T00:00:00Z" }) } }]);
      await rt.store.as(user("b")).write([{ insert: "notes", values: { title: "same", due: "2026-01-02T00:00:00Z" } }]);
      const rows = []; let cursor;
      do { const page = await rt.store.as(user("a")).view("page", { input: { omit: "other" }, limit: 2, cursor }); rows.push(...page.rows); cursor = page.nextCursor; } while (cursor);
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map(r => r.id)).size).toBe(5);
      expect(rows.every(r => r.title === "same" && r.siblings === 6 && !Object.hasOwn(r, "owner"))).toBe(true);
      expect(rows.every(r => r.due === null || r.due === "2026-01-02T00:00:00.000000Z")).toBe(true);
      expect((await rt.store.as(user("a")).view("nested")).rows).toHaveLength(6);
      const collision = (await rt.store.as(user("a")).view("collision")).rows;
      expect(collision).toHaveLength(8); expect(collision.every(r => r.marker === 1 && r.id !== "fake")).toBe(true);
      expect((await rt.store.as(user("a")).view("own-cte")).rows).toHaveLength(8);
      const limited = (await rt.store.as(user("a")).view("first-twice")).rows;
      expect(limited).toHaveLength(2); expect(limited.every(r => r.n === 2)).toBe(true);
      expect((await rt.store.as(user("a")).view("renamed-columns")).rows).toHaveLength(8);
      expect((await rt.store.as(user("absent")).view("collision")).rows).toEqual([]);
    } finally { if (engine === "postgres") await native.drop(); else await native.dispose(); }
  }, 60_000);
  it("retains publication/TTL policy, bound caller/time, DML subqueries and runtime CTE-tag checks", async () => {
    const dialect = engine === "postgres" ? pgCompile : undefined;
    const refs = {};
    const compile = async (kind, sql, inputs = {}) => {
      const r = await compileSql(sql, { schemas, inputs, kind, views: refs }, dialect);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r;
    };
    refs.feed = { select: (await compile("view", "SELECT id, title FROM posts")).reference };
    refs.inventory = { select: (await compile("view", "SELECT id, name FROM items")).reference };
    refs.clock = { select: (await compile("view", "SELECT now() AS instant, auth.uid() AS actor")).reference };
    const native = engine === "postgres" ? await freshSchema() : await LocalD1.create();
    try {
      const storage = engine === "postgres" ? postgresStorage({ connect: native.connect }) : sqliteStorage(native);
      const b = await boot({ storage, driver: engine === "postgres" ? pgDatabaseDriver(native.connect) : native });
      const pub = { ...site(b), mode: "public" };
      const p = async (kind, sql, inputs = {}) => ({ kind, inputs, ir: (await compile(kind, sql, inputs)).plan.stmts });
      expect((await runView(pub, await p("view", "SELECT id, title FROM feed ORDER BY id"), caller())).rows).toEqual([{ id: "p1", title: "Hello world" }]);
      const scoped = await p("view", "SELECT i.id FROM inventory i JOIN clock c ON c.actor = auth.uid() AND c.instant = now() ORDER BY i.id");
      expect((await runView(site(b), scoped, caller())).rows.map(r => r.id)).toEqual(["a", "b", "c", "d"]);
      const insert = await p("procedure", "INSERT INTO settings (key, value) SELECT id, name FROM inventory RETURNING key");
      expect((await runProcedure(site(b), insert, caller())).rows[0].map(r => r.key).sort()).toEqual(["a", "b", "c", "d"]);
      const update = await p("procedure", "UPDATE settings SET value = 'changed' WHERE key IN (SELECT id FROM inventory) RETURNING key");
      expect((await runProcedure(site(b), update, caller())).rows[0].map(r => r.key).sort()).toEqual(["a", "b", "c", "d"]);
      const forged = structuredClone(scoped);
      const visit = n => { if (!n || typeof n !== "object") return; if (n.RangeVar?.mantle === "table") n.RangeVar.mantle = "cte"; Object.values(n).forEach(visit); }; visit(forged.ir);
      await expect(runView(site(b), forged, caller())).rejects.toThrow(/cte reference is not defined in scope/);
      expect((await compileSql("WITH x AS (SELECT owner FROM items) SELECT owner FROM x", { schemas, inputs: {}, kind: "view" }, dialect)).ok).toBe(false);
      // The engine explains the actual policy-injected statement; no source-text index guess.
      if (engine === "sqlite") {
        let sent;
        const seen = { ...site(b), executor: { ...b.executor, maxBindings: b.executor.maxBindings, apply: x => b.executor.apply(x), select: async x => { sent = x; return b.executor.select(x); } } };
        await runView(seen, scoped, caller());
        const { print } = await import("../../src/d1/print.js");
        const details = await native.all({ sql: "EXPLAIN QUERY PLAN " + print(sent.ir), binds: sent.binds });
        expect(details.some(r => /SEARCH items USING INDEX/.test(String(r.detail)))).toBe(true);
      }
    } finally { if (engine === "postgres") await native.drop(); else await native.dispose(); }
  }, 60_000);

});
it("base WITH remains closed against recursive, materialized and data-changing CTEs and volatile functions", async () => {
  const ctx = { schemas: { notes: { fields: { title: "text" } } }, inputs: {}, kind: "view" };
  expect((await compileSql("WITH x AS (SELECT id FROM notes) SELECT id FROM x", ctx)).ok).toBe(true);
  for (const sql of ["WITH RECURSIVE x AS (SELECT id FROM notes) SELECT id FROM x", "WITH x AS MATERIALIZED (SELECT id FROM notes) SELECT id FROM x", "WITH x AS (DELETE FROM notes RETURNING id) SELECT id FROM x", "SELECT random() AS x FROM notes", "SELECT clock_timestamp() AS x FROM notes"]) expect((await compileSql(sql, ctx)).ok, sql).toBe(false);
});

it("checks CTE declaration, column and relation aliases against native printing and reserved bindings", async () => {
  const ctx = { schemas: { notes: { fields: { title: "text" } } }, inputs: { id: "text" }, kind: "view" };
  for (const sql of ["WITH nothing AS (SELECT id FROM notes) SELECT id FROM nothing", "WITH x(nothing) AS (SELECT id FROM notes) SELECT nothing FROM x", "WITH x AS (SELECT id FROM notes) SELECT id FROM x nothing", "WITH x AS (SELECT id FROM notes) SELECT input.id FROM x input"]) expect((await compileSql(sql, ctx)).ok, sql).toBe(false);
});
