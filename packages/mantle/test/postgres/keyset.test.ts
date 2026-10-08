// @ts-nocheck test code over loosely typed plans and rows
/**
 * The paged View's cursor on PostgreSQL: when every sort key (the appended tiebreaks included) is NOT NULL and they share one direction,
 * the cursor is one row comparison `(k0, k1) > ($1, $2)`, which a btree range-scans however deep the page; any other sort keeps the
 * expanded OR form. Golden SQL says which one a View gets, paging says both return exactly the unpaged rows, EXPLAIN says the index serves the row form.
 */
import { expect, it } from "vitest";
import { RUNTIME_PLAN_VERSION } from "../../src/spec/index.js";
import { pgDatabaseDriver, postgresDialect, postgresStorage } from "../../src/postgres/index.js";
import { print, typed } from "../../src/postgres/print.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { Db, caller, program, runView, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";

const schemas = {
  reqs: { fields: { amount: "integer", name: "text", ref: "text" } },
  notes: { scope: "owner", publishing: true, fields: { title: "text" } },
};

/** The WHERE of the outer select of the paged statement a View runs for `cursor`. */
async function cursorSql(sql: string, cursor: unknown[]) {
  useCompileSide(pgCompile);
  const seen: any[] = [];
  const s = { schemas, dialect: postgresDialect(), executor: { maxBindings: 1000, apply: async () => [], select: async (st) => (seen.push(st), []) } };
  await runView(s, await program("view", sql, {}, schemas), caller(), { pageSize: 3, cursor });
  return print(typed(seen.at(-1).ir, schemas)).replace(/^.*\) AS _p WHERE /, "");
}
const ROW = /^\(_p\._k0(, _p\._k\d)*\) [<>] \(\$\d+(, \$\d+)*\) ORDER BY/;
const EXPANDED = /^\(?\(?_p\._k0 [<>] /;

it("the cursor is a row comparison exactly when every key is NOT NULL and they share one direction", async () => {
  try {
    // native columns are NOT NULL, and the appended id tiebreak follows the last key
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at DESC", ["2026-01-01T00:00:00Z", "a"])).toBe("(_p._k0, _p._k1) < ($1, $2) ORDER BY _p._k0 DESC NULLS FIRST, _p._k1 DESC NULLS FIRST LIMIT 4");
    expect(await cursorSql("SELECT id FROM reqs ORDER BY updated_at, created_at", ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "a"])).toMatch(/^\(_p\._k0, _p\._k1, _p\._k2\) > \(\$1, \$2, \$3\) ORDER BY/);
    expect(await cursorSql("SELECT id FROM reqs ORDER BY id", ["a", "a"])).toMatch(ROW);
    // a scope column and a publishing status are NOT NULL; so is a native column read through a subquery
    expect(await cursorSql("SELECT n.id FROM notes n ORDER BY n.status DESC", ["published", "a"])).toMatch(ROW);
    expect(await cursorSql("SELECT s.id FROM (SELECT id, created_at AS at FROM reqs) s ORDER BY s.at", ["2026-01-01T00:00:00Z", "a"])).toMatch(ROW);
    // an inner join does not null-extend
    expect(await cursorSql("SELECT r.id FROM reqs r JOIN notes n ON n.id = r.ref ORDER BY n.updated_at, r.id", ["2026-01-01T00:00:00Z", "a"])).toMatch(ROW);

    // not the row form: a declared field is nullable, whatever the Schema says about it
    expect(await cursorSql("SELECT id FROM reqs ORDER BY amount", [5, "a"])).toMatch(EXPANDED);
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at DESC, name DESC", ["2026-01-01T00:00:00Z", "x", "a"])).toMatch(EXPANDED);
    // an expression, even over NOT NULL columns, and an author column the subquery computes
    expect(await cursorSql("SELECT id FROM reqs ORDER BY coalesce(created_at, now())", ["2026-01-01T00:00:00Z", "a"])).toMatch(EXPANDED);
    expect(await cursorSql("SELECT s.id FROM (SELECT id, amount AS created_at FROM reqs) s ORDER BY s.created_at", [5, "a"])).toMatch(EXPANDED);
    // the nullable side of an outer join
    expect(await cursorSql("SELECT r.id FROM reqs r LEFT JOIN notes n ON n.id = r.ref ORDER BY n.updated_at, r.id", ["2026-01-01T00:00:00Z", "a"])).toMatch(EXPANDED);
    expect(await cursorSql("SELECT n.id FROM notes n LEFT JOIN reqs r ON r.id = n.title ORDER BY r.created_at", ["2026-01-01T00:00:00Z", "a"])).toMatch(EXPANDED);
    // a CTE is not a table, even when it is named like one
    expect(await cursorSql("WITH reqs AS (SELECT id, amount AS created_at FROM reqs) SELECT id FROM reqs ORDER BY created_at", [5, "a"])).toMatch(EXPANDED);
    // mixed directions
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at DESC, id", ["2026-01-01T00:00:00Z", "a", "a"])).toMatch(EXPANDED);
    // a NULLS clause other than PostgreSQL's default; PostgreSQL's own default spelled out is still the row form
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at DESC NULLS LAST", ["2026-01-01T00:00:00Z", "a"])).toMatch(EXPANDED);
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at NULLS FIRST", ["2026-01-01T00:00:00Z", "a"])).toMatch(EXPANDED);
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at DESC NULLS FIRST", ["2026-01-01T00:00:00Z", "a"])).toMatch(ROW);
    // the first page has no cursor to compare
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at", undefined)).not.toContain("_p._k0 >");
    // a forged cursor (a null element, or the wrong length) cannot take the row form: it falls back to the expanded one
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at", [null, "a"])).not.toMatch(ROW);
    expect(await cursorSql("SELECT id FROM reqs ORDER BY created_at", ["2026-01-01T00:00:00Z"])).not.toMatch(ROW);
  } finally { useCompileSide(undefined); }
});

const plan = { version: RUNTIME_PLAN_VERSION, dialect: { name: pgCompile.name, version: pgCompile.version }, fingerprint: "keyset", views: {}, procedures: {}, triggers: {},
  schemas: Object.fromEntries(Object.entries({ items: { fields: { amount: "integer", name: "text" }, indexes: [["amount", "id"]] }, rows: { fields: { amount: "integer" }, indexes: [["created_at", "id"]] } })
    .map(([n, d]) => [n, { ...d, name: n, names: {}, schema: { type: "object" } }])) };
const itemSchemas = Object.fromEntries(Object.entries(plan.schemas).map(([n, d]) => [n, { fields: d.fields, indexes: d.indexes }]));

it.skipIf(!PG_URL)("paged one to seven rows at a time, both cursor forms return exactly the unpaged rows; the row form is an Index Cond", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const storage = postgresStorage({ connect: db.connect });
    const { executor } = await storage.prepare(plan);
    const d = new Db(pgDatabaseDriver(db.connect));
    // created_at repeats in blocks of 7, amount repeats and is NULL for every tenth row
    await d.exec([
      "INSERT INTO items (id, created_at, updated_at, amount, name) SELECT 'i' || lpad(g::text, 5, '0'), '2026-01-01'::timestamptz + (g / 7) * interval '1 second', now(), CASE WHEN g % 10 = 0 THEN NULL ELSE g % 13 END, 'n' || (g % 5) FROM generate_series(1, 100) g",
      "INSERT INTO rows (id, created_at, updated_at, amount) SELECT 'r' || lpad(g::text, 6, '0'), '2026-01-01'::timestamptz + (g / 7) * interval '1 second', now(), g FROM generate_series(1, 60000) g",
      "ANALYZE items", "ANALYZE rows",
    ]);
    const seen: any[] = [];
    const s = { d1: d, schemas: itemSchemas, dialect: storage.dialect, executor: { maxBindings: executor.maxBindings, apply: (b) => executor.apply(b), select: (st) => (seen.push(st), executor.select(st)) } };
    const ids = (rows) => rows.map((r) => r.id);
    const walk = async (p, pageSize) => {
      const got = [];
      for (let cursor; ;) {
        const page = await runView(s, p, caller(), { pageSize, ...(cursor ? { cursor } : {}) });
        got.push(...page.rows);
        if (!(cursor = page.next)) return got;
      }
    };
    const form = (st) => (/\(_p\._k0, _p\._k1/.test(print(typed(st.ir, itemSchemas))) ? "row" : "expanded");
    for (const [sql, want] of [
      ["SELECT id, created_at FROM items ORDER BY created_at DESC", "row"],
      ["SELECT id, created_at FROM items ORDER BY created_at", "row"],
      ["SELECT id, amount FROM items ORDER BY amount", "expanded"],
      ["SELECT id, amount FROM items ORDER BY amount DESC", "expanded"],
      ["SELECT id, amount, name FROM items ORDER BY name, created_at DESC", "expanded"],
    ]) {
      const p = await program("view", sql, {}, itemSchemas);
      const all = await runView(s, p, caller(), {});
      expect(all.rows.length).toBe(100);
      for (let size = 1; size <= 7; size++) {
        seen.length = 0;
        const got = await walk(p, size);
        expect(ids(got), `${sql} / ${size}`).toEqual(ids(all.rows));
        expect(new Set(ids(got)).size).toBe(100);
        // the first page has no cursor; every later one has the form the View is entitled to
        expect(seen.slice(1).map(form).every((f) => f === want), `${sql} / ${size} is ${want}`).toBe(true);
      }
    }

    // a deep page: the planner range-scans the index on the row comparison (an Index Cond), with no Sort
    const p = await program("view", "SELECT id, created_at FROM rows ORDER BY created_at DESC", {}, itemSchemas);
    const first = await runView(s, p, caller(), { pageSize: 50 });
    const deep = ["2026-01-01T02:00:00.000Z", "r050000"];
    seen.length = 0;
    await runView(s, p, caller(), { pageSize: 50, cursor: deep });
    const st = seen.at(-1);
    const [r] = await d.driver.batch([{ sql: `EXPLAIN (FORMAT JSON) ${print(typed(st.ir, itemSchemas))}`, binds: st.binds }]);
    const raw = r.rows[0]["QUERY PLAN"];
    const text = JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw);
    expect(first.next).toBeDefined();
    expect(text).toContain("Index Cond");
    expect(text).toMatch(/ROW\(created_at, id\) < ROW\(/);
    expect(text).not.toContain('"Node Type":"Sort"');
  } finally { useCompileSide(undefined); await db.drop(); }
}, 120_000);
