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
  ["jsonb_array_elements_text unnests a column with its ordinality, under the caller's visibility",
    "SELECT i.id, j.value AS tag, j.n FROM items i, jsonb_array_elements_text(i.tags) WITH ORDINALITY AS j(value, n) WHERE j.value <> 'blue' ORDER BY i.id, j.n",
    [{ id: "a", tag: "red", n: 1 }, { id: "a", tag: "big", n: 2 }, { id: "c", tag: "red", n: 1 }, { id: "d", tag: "red", n: 1 }]],
  ["jsonb_each_text of an object, and ->> by key and by index",
    "SELECT i.id, e.key, e.value FROM items i, jsonb_each_text(jsonb_build_object('k', i.tags ->> 0)) AS e(key, value) WHERE i.id = 'a'",
    [{ id: "a", key: "k", value: "red" }]],
  ["a bigint compared, and an integer's truth written out", "SELECT id FROM items WHERE stock <> 0 AND (stock > 4)::bool ORDER BY id", [{ id: "a" }, { id: "c" }, { id: "d" }]],
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

// SQLite spellings (ADR-0039): refused with the PostgreSQL one to use
const REFUSED: [string, string, RegExp][] = [
  ["json_each", "SELECT j.value AS v FROM items i, json_each(i.tags) j", /json_each\(\) is SQLite's: use jsonb_array_elements_text\(x\) WITH ORDINALITY AS j\(value, n\)/],
  ["a $ path of ->>", "SELECT tags ->> '$[0]' AS t FROM items", /'\$\[0\]' is a SQLite JSON path.*x ->> 'key', x ->> 0 or x #>> '\{a,b\}'/],
  ["json_extract", "SELECT json_extract(tags, '$[0]') AS t FROM items", /json_extract\(\) is SQLite's: use x ->> 'key'/],
  ["hex", "SELECT hex(name) AS t FROM items", /hex\(\) is SQLite's/],
  ["a View's top-level UNION", "SELECT id FROM items UNION SELECT id FROM requisitions", /UNION, INTERSECT and EXCEPT go inside a WITH or a subquery/],
  ["a View's top-level DISTINCT ON", "SELECT DISTINCT ON (cat) id FROM items ORDER BY cat", /DISTINCT ON goes inside a WITH or a subquery/],
  ["a GROUPS frame", "SELECT id, count(*) OVER (ORDER BY stock GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS n FROM items", /GROUPS frames and EXCLUDE are refused/],
  ["a frame offset that is not a literal", "SELECT id, count(*) OVER (ORDER BY stock ROWS BETWEEN stock PRECEDING AND CURRENT ROW) AS n FROM items", /a frame offset is a literal/],
  ["lag without OVER", "SELECT lag(id) AS p FROM items", /lag\(\) is a window function/],
  ["FILTER on a function that is not an aggregate", "SELECT lower(name) FILTER (WHERE true) AS l FROM items", /FILTER and ORDER BY belong to an aggregate/],
  ["generate_series", "SELECT g.id FROM generate_series(1, 3) g", /only jsonb_array_elements\(\), jsonb_array_elements_text\(\), jsonb_each\(\), jsonb_each_text\(\) are allowed in FROM/],
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
  const db = await freshSchema({ statementTimeoutMs: 200 });
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

it.skipIf(!PG_URL)("a Schema field read through a CTE keeps its name and type, through renamed columns and a later sibling", async () => {
  const { compilePlan } = await import("../../src/spec/index.js");
  const { createMantleRuntime } = await import("../../src/core/index.js");
  const doc = (kind: string, name: string, spec: string) => `apiVersion: cms.mantle.aotter.net/v2\nkind: ${kind}\nmetadata: { name: ${name} }\nspec:\n${spec}`;
  const notes = doc("Schema", "notes", `  title: Notes\n  lifecycle: operational\n  scope: { ownerId: auth.uid() }\n  schema:\n    type: object\n    required: [ownerId]\n    properties: { ownerId: { type: string }, dueAt: { type: string, format: date-time } }\n  indexes: [[ownerId, dueAt]]`);
  const view = (name: string, sql: string) => doc("View", name, `  surface: public\n  requires: { auth: { all: [ctx.user] } }\n  sql: "${sql}"`);
  const res = await compilePlan({ sources: [{ sourceId: "memory:cte", text: [notes,
    view("dup", "WITH x(p, q) AS (SELECT n.id AS k, n.dueAt AS k FROM notes n) SELECT x.p, x.q FROM x"),
    view("cast", "WITH a AS (SELECT n.id, CAST(n.dueAt AS date) AS dueAt FROM notes n) SELECT a.id, a.dueAt FROM a"),
    view("due", "WITH a AS (SELECT n.id, n.dueAt FROM notes n), b(id, due) AS (SELECT a.id, a.dueAt FROM a) SELECT a.id, a.dueAt, b.due FROM a JOIN b ON b.id = a.id ORDER BY a.dueAt"),
  ].join("\n---\n") }] }, pgCompile);
  expect(res.ok, JSON.stringify(res.diagnostics)).toBe(true);
  expect(res.plan.views.dup.columns.q).toEqual({ schema: "notes", field: "dueat" });
  expect(res.plan.views.cast.columns?.dueat).toBeUndefined();
  expect(res.plan.views.due.columns).toMatchObject({ dueat: { schema: "notes", field: "dueat" }, due: { schema: "notes", field: "dueat" } });
  const db = await freshSchema();
  try {
    const rt = await createMantleRuntime({ plan: res.plan, handlers: {}, storage: postgresStorage({ connect: db.connect }) });
    const me = { kind: "user", subject: "u1", role: null, scopes: [], credential: "session", credentialId: null, clientId: null } as const;
    await rt.store.as(me).write([{ insert: "notes", values: { dueAt: "2026-01-02T00:00:00Z" } }]);
    const [row] = (await rt.store.as(me).view("due")).rows;
    expect(Object.keys(row)).toEqual(["id", "dueAt", "due"]);
    expect([row.dueAt, row.due]).toEqual(["2026-01-02T00:00:00.000000Z", "2026-01-02T00:00:00.000000Z"]);
  } finally { await db.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("RETURNING <target>.* is the target's declared columns, as RETURNING * is", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect }), driver: pgDatabaseDriver(db.connect) }));
    const keys = async (sql: string) => Object.keys((await runProcedure(s, await program("procedure", sql), caller())).rows[0][0]).sort();
    const star = await keys("INSERT INTO settings (key, value) VALUES ('a', 'b') RETURNING *");
    expect(await keys("INSERT INTO settings (key, value) VALUES ('c', 'd') RETURNING settings.*")).toEqual(star);
    expect(await keys("UPDATE settings AS t SET value = 'e' WHERE t.key = 'c' RETURNING t.*")).toEqual(star);
    expect(star).not.toContain("owner");
    // a star of anything but the target is left to PostgreSQL, which refuses it; it is never read as the target's columns
    await expect(runProcedure(s, await program("procedure", "INSERT INTO settings (key, value) VALUES ('f', 'g') RETURNING nope.*"), caller())).rejects.toThrow();
  } finally { useCompileSide(undefined); await db.drop(); }
}, 60_000);

it("a SQLite spelling is refused at its position, with the PostgreSQL spelling", async () => {
  const { compileSql } = await import("../../src/spec/index.js");
  const { schemas } = await import("../../src/testing/harness.js");
  for (const [sql, at, say] of [
    ["SELECT j.value AS v FROM items i, json_each(i.tags) j", "SELECT j.value AS v FROM items i, ".length, "jsonb_array_elements_text"],
    ["SELECT id FROM items WHERE tags ->> '$.a' = 'x'", "SELECT id FROM items WHERE tags ->> ".length, "x ->> 'key'"],
  ] as const) {
    const r = await compileSql(sql, { schemas, inputs: {}, kind: "view" }, pgCompile);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(say);
    expect(JSON.stringify(r)).toMatch(new RegExp(`"(?:offset|position|start)":\\s*${at}\\b`));
  }
});

it.skipIf(!PG_URL)("a paged View over jsonb row sources is keyed by their ordinality and loses no row; without one it is refused at compile time", async () => {
  const db = await freshSchema();
  useCompileSide(pgCompile);
  try {
    const s = site(await boot({ storage: postgresStorage({ connect: db.connect }), driver: pgDatabaseDriver(db.connect) }));
    const pageAll = async (sql: string) => {
      const p = await program("view", sql);
      const got: string[] = [];
      let cursor;
      for (let i = 0; i < 12; i++) {
        const page = await runView(s, p, caller(), { cursor, pageSize: 1 });
        got.push(...page.rows.map((r) => Object.values(r).join("/")));
        if (!page.next) break;
        cursor = page.next;
      }
      return got;
    };
    const one = ["a/red", "a/big", "b/blue", "c/red", "d/red"];
    const src = "jsonb_array_elements_text(i.tags) WITH ORDINALITY AS j(value, n)";
    expect(await pageAll(`SELECT i.id, j.value FROM items i, ${src} ORDER BY i.id`)).toEqual(one);
    expect(await pageAll(`SELECT i.id, j.value FROM items i JOIN ${src} ON true ORDER BY i.id`)).toEqual(one);
    expect(await pageAll(`SELECT i.id, j.value FROM items i LEFT JOIN ${src} ON true ORDER BY i.id`)).toEqual(one);
    const two = await pageAll(`SELECT i.id, j.value, k.value AS v2 FROM items i, ${src}, jsonb_array_elements_text(i.tags) WITH ORDINALITY AS k(value, n) ORDER BY i.id`);
    expect(two).toHaveLength(7);
    expect(new Set(two).size).toBe(7);
    // a row source first in FROM is keyed by its ordinality alone (#1402)
    expect(await pageAll(`SELECT j.value FROM jsonb_array_elements_text('["z","x","x"]'::jsonb) WITH ORDINALITY AS j(value, n) ORDER BY j.value`)).toEqual(["x", "x", "z"]);
    // a subquery whose id repeats (a join with a row source fans it out) is refused; a single table's own id is kept
    const unique = /needs a unique id/;
    const run = async (sql: string) => runView(s, await program("view", sql), caller(), { pageSize: 1 });
    await expect(run(`SELECT s.id FROM (SELECT i.id FROM items i, ${src}) s ORDER BY s.id`)).rejects.toThrow(unique);
    await expect(run(`SELECT s.id FROM (SELECT i.id FROM items i JOIN ${src} ON true) s ORDER BY s.id`)).rejects.toThrow(unique);
    await expect(run(`SELECT s.id FROM (SELECT i.id FROM items i UNION ALL SELECT i.id FROM items i, ${src}) s ORDER BY s.id`)).rejects.toThrow(unique);
    await expect(run("SELECT s.id FROM (SELECT i.name AS id FROM items i) s ORDER BY s.id")).rejects.toThrow(unique);
    expect(await pageAll("SELECT s.id, s.stock FROM (SELECT i.id, i.stock FROM items i WHERE i.stock > 1) s ORDER BY s.stock")).toEqual(["b/2", "a/5", "d/7", "c/9"]);
    // a set operation matches by position, a CTE is checked as a subquery is, and grouping by the id keeps it unique
    await expect(run("SELECT s.id FROM (SELECT i.id, i.name FROM items i UNION ALL SELECT i.name, i.id FROM items i) s ORDER BY s.id")).rejects.toThrow(unique);
    await expect(run(`WITH x AS (SELECT i.id FROM items i, ${src}) SELECT x.id FROM x ORDER BY x.id`)).rejects.toThrow(unique);
    await expect(run(`SELECT s.id FROM (SELECT i.id FROM items i, ${src} GROUP BY i.id) s ORDER BY s.id`)).resolves.toBeDefined();
    // a table after a row source first in FROM would repeat the row source's key
    await expect(run(`SELECT i.id FROM jsonb_array_elements_text('["a"]'::jsonb) WITH ORDINALITY AS j(value, n) JOIN items i ON true ORDER BY j.value`)).rejects.toThrow(/put the table first/);
    const ask = /alias and WITH ORDINALITY/;
    await expect(program("view", "SELECT i.id, j.value AS tag FROM items i, jsonb_array_elements_text(i.tags) AS j(value) ORDER BY i.id")).rejects.toThrow(ask);
    await expect(program("view", "SELECT i.id FROM items i JOIN jsonb_array_elements_text(i.tags) AS j(value) ON true ORDER BY i.id")).rejects.toThrow(ask);
    await expect(program("view", "SELECT i.id FROM items i, jsonb_array_elements_text(i.tags) WITH ORDINALITY ORDER BY i.id")).rejects.toThrow(ask);
    await expect(program("view", "SELECT x.id FROM items AS x(owner) ORDER BY x.id")).rejects.toThrow(/column list/);
    await expect(program("view", "SELECT s.a FROM (SELECT id, stock FROM items) AS s(a, b) ORDER BY s.a")).rejects.toThrow(/column list|s.a is not a declared field/);
    await expect(program("view", "SELECT j.nope FROM items i, jsonb_array_elements_text(i.tags) AS j(value) WHERE j.nope = 'x'")).rejects.toThrow(/names its columns/);
    await expect(program("view", "SELECT j.value FROM items i, pg_catalog.jsonb_array_elements_text(i.tags) AS j(value)")).rejects.toThrow(/allowed in FROM/);
  } finally { useCompileSide(undefined); await db.drop(); }
}, 60_000);
