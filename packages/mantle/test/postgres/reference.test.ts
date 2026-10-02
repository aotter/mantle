// @ts-nocheck test code over loosely typed IR and rows
/**
 * ADR-0037's reference profile on PostgreSQL: each construct of decision 2 gives PostgreSQL's result over the harness fixture
 * (another owner's and expired rows never appear), and what the profile still refuses is refused with a position.
 */
import { expect, it } from "vitest";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, caller, program, runProcedure, runView, site, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";

const VIEWS: [string, string, unknown[]][] = [
  ["a CTE feeding a moving window over ROWS",
    "WITH s AS (SELECT id, stock FROM items) SELECT id, max(stock) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS m FROM s ORDER BY id",
    [{ id: "a", m: 5 }, { id: "b", m: 5 }, { id: "c", m: 9 }, { id: "d", m: 9 }]],
  ["lag over the caller's rows only", "SELECT id, lag(id) OVER (ORDER BY id) AS prev FROM items ORDER BY id",
    [{ id: "a", prev: null }, { id: "b", prev: "a" }, { id: "c", prev: "b" }, { id: "d", prev: "c" }]],
  ["FILTER on an aggregate", "SELECT count(*) FILTER (WHERE cat = 'x') AS xs, count(*) AS n FROM items", [{ xs: 3, n: 4 }]],
  ["DISTINCT ON inside a subquery keeps the row its ORDER BY puts first",
    "SELECT t.cat, t.id FROM (SELECT DISTINCT ON (cat) cat, id FROM items ORDER BY cat, stock DESC) t ORDER BY t.cat",
    [{ cat: "x", id: "d" }, { cat: "y", id: "c" }]],
  ["jsonb containment on a json field", "SELECT id FROM items WHERE tags @> '[\"red\"]'::jsonb ORDER BY id", [{ id: "a" }, { id: "c" }, { id: "d" }]],
  ["jsonb_agg of jsonb_build_object with its own ORDER BY",
    "SELECT jsonb_agg(jsonb_build_object('id', id, 'stock', stock) ORDER BY stock DESC) AS j FROM items",
    [{ j: [{ id: "c", stock: 9 }, { id: "d", stock: 7 }, { id: "a", stock: 5 }, { id: "b", stock: 2 }] }]],
  ["ILIKE and a regular expression", "SELECT id FROM items WHERE name ILIKE 'A%' OR name ~ '^b' ORDER BY id", [{ id: "a" }, { id: "b" }]],
  ["greatest, least, floor", "SELECT id, greatest(stock, 6) AS g, least(stock, 6) AS l, floor(stock / 2.0) AS f FROM items ORDER BY id",
    [{ id: "a", g: 6, l: 5, f: 2 }, { id: "b", g: 6, l: 2, f: 1 }, { id: "c", g: 9, l: 6, f: 4 }, { id: "d", g: 7, l: 6, f: 3 }]],
  ["a cast of a column, and AT TIME ZONE", "SELECT id, CAST(stock AS text) AS s, (created_at AT TIME ZONE 'UTC')::date = CAST(created_at AS date) AS same FROM items ORDER BY id",
    [{ id: "a", s: "5", same: true }, { id: "b", s: "2", same: true }, { id: "c", s: "9", same: true }, { id: "d", s: "7", same: true }]],
  ["a bare text literal compared with a date-time column is PostgreSQL's cast", "SELECT count(*) AS n FROM items WHERE created_at > '1969-12-31'", [{ n: 4 }]],
  ["INTERSECT inside a CTE", "WITH r AS (SELECT id FROM items WHERE cat = 'x' INTERSECT SELECT id FROM items WHERE stock > 4) SELECT id FROM r ORDER BY id", [{ id: "a" }, { id: "d" }]],
  ["a CTE named like the Schema it reads: the body reads the Schema, scoped", "WITH items AS (SELECT id, name FROM items) SELECT id FROM items ORDER BY id", [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]],
  ["a WITH on a set operation's branch", "SELECT u.id FROM ((WITH z AS (SELECT id FROM items) SELECT id FROM z) UNION ALL SELECT id FROM requisitions) u ORDER BY u.id",
    [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "r1" }, { id: "r2" }]],
];

const REFUSED: [string, string, RegExp][] = [
  ["a View's top-level UNION", "SELECT id FROM items UNION SELECT id FROM requisitions", /UNION, INTERSECT and EXCEPT go inside a WITH or a subquery/],
  ["a View's top-level DISTINCT ON", "SELECT DISTINCT ON (cat) id FROM items ORDER BY cat", /DISTINCT ON goes inside a WITH or a subquery/],
  ["a GROUPS frame", "SELECT id, count(*) OVER (ORDER BY stock GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS n FROM items", /GROUPS frames and EXCLUDE are refused/],
  ["a frame offset that is not a literal", "SELECT id, count(*) OVER (ORDER BY stock ROWS BETWEEN stock PRECEDING AND CURRENT ROW) AS n FROM items", /a frame offset is a literal/],
  ["lag without OVER", "SELECT lag(id) AS p FROM items", /lag\(\) is a window function/],
  ["FILTER on a function that is not an aggregate", "SELECT lower(name) FILTER (WHERE true) AS l FROM items", /FILTER and ORDER BY belong to an aggregate/],
  ["generate_series", "SELECT g.id FROM generate_series(1, 3) g", /only json_each\(\) is allowed in FROM/],
  ["a quoted CTE name that is not lower case", 'WITH "Items" AS (SELECT id FROM items) SELECT id FROM "Items" ORDER BY id', /a CTE name is lower case/],
  ["lag with an offset that is not a literal", "SELECT id, lag(id, stock) OVER (ORDER BY id) AS p FROM items ORDER BY id", /lag's offset is an integer literal/],
];

it.skipIf(!PG_URL)("the reference profile's constructs give PostgreSQL's results, under the caller's visibility", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect }), driver: pgDatabaseDriver(db.connect) }));
    for (const [what, sql, rows] of VIEWS) expect((await runView(s, await program("view", sql), caller())).rows, what).toEqual(rows);
    for (const [what, sql, message] of REFUSED) await expect(program("view", sql), what).rejects.toThrow(message);
    // INSERT ... SELECT over a set operation: the fills land in their own columns, and each branch is scoped
    const { rows } = await runProcedure(s, await program("procedure", "INSERT INTO settings (key, value) SELECT name, cat FROM items UNION SELECT state, state FROM requisitions RETURNING key"), caller());
    expect(rows[0].map((r) => r.key).sort()).toEqual(["apple", "berry", "cherry", "date", "pending"]);
    // a write inside WITH is refused in a Procedure too
    await expect(program("procedure", "INSERT INTO orders (item_id, qty) WITH x AS (DELETE FROM items RETURNING id) SELECT id, 1 FROM x")).rejects.toThrow(/a CTE body is a SELECT/);
  } finally { useCompileSide(undefined); await db.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a statement past statement_timeout fails as RESOURCE_UNAVAILABLE, and restrict refuses a program at runtime", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const restrict = (plan) => (JSON.stringify(plan.stmts).includes('"requisitions"') ? [{ code: "SQL_RELATION", message: "requisitions is not for this tenant" }] : []);
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect, statementTimeoutMs: 200, restrict }), driver: pgDatabaseDriver(db.connect) }));
    const forever = await program("view", "WITH RECURSIVE r AS (SELECT 1 AS n FROM items UNION ALL SELECT r.n + 1 AS n FROM r) SELECT count(*) AS c FROM r");
    const started = Date.now();
    const err = await runView(s, forever, caller()).catch((e) => e);
    expect(err?.diagnostic?.code).toBe("RESOURCE_UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(5_000);
    const denied = await runView(s, await program("view", "SELECT id FROM requisitions ORDER BY id"), caller()).catch((e) => e);
    expect(denied?.diagnostic?.message).toMatch(/requisitions is not for this tenant/);
    expect((await runView(s, await program("view", "SELECT id FROM items ORDER BY id"), caller())).rows).toHaveLength(4);
  } finally { useCompileSide(undefined); await db.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("the runtime honors a cte tag only for a CTE in scope: a forged one never reads a table or the catalog", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect }), driver: pgDatabaseDriver(db.connect) }));
    const p = await program("view", "WITH items AS (SELECT id, name FROM items) SELECT id, name FROM items ORDER BY id");
    expect((await runView(s, p, caller())).rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    // the CTE's body read retagged as the CTE itself: PostgreSQL would read the raw table, every owner's and expired rows
    const forged = JSON.parse(JSON.stringify(p).replace('"relname":"items","inh":true,"relpersistence":"p","mantle":"table"', '"relname":"items","inh":true,"relpersistence":"p","mantle":"cte"'));
    expect(JSON.stringify(forged)).not.toContain('"mantle":"table"');
    await expect(runView(s, forged, caller())).rejects.toThrow(/cte reference is not defined in scope/);
    // the same with a catalog view's name
    const catalog = JSON.parse(JSON.stringify(forged).replaceAll('"items"', '"pg_tables"').replaceAll('"name"', '"tablename"'));
    await expect(runView(s, catalog, caller())).rejects.toThrow(/cte reference is not defined in scope|not a declared/);
  } finally { useCompileSide(undefined); await db.drop(); }
}, 60_000);

it("a public View's CTE over a publishing Schema is not read as an unpublished relation", async () => {
  const { compileSql } = await import("../../src/spec/index.js");
  const { schemas } = await import("../../src/testing/harness.js");
  const r = await compileSql("WITH x AS (SELECT id, title FROM posts) SELECT id, title FROM x ORDER BY id", { schemas, inputs: {}, kind: "view", public: true }, pgCompile);
  expect(r.ok, JSON.stringify(r)).toBe(true);
});
