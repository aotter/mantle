// @ts-nocheck test code over loosely typed IR and rows
/**
 * What the compliance suite leaves to each dialect, checked for PostgreSQL: convergence on a second boot and on a plan change,
 * the CHECK message, a unique conflict's op, guards under concurrent writers, the site time zone, and values written from
 * jsonb_array_elements, whose text values PostgreSQL needs cast to the column's type.
 */
import { expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";
import { print } from "../../src/postgres/print.js";
import { RUNTIME_PLAN_VERSION } from "../../src/spec/index.js";
import { DiagnosticError } from "../../src/spec/kernel/index.js";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
import { convergeStorage } from "../../src/postgres/storage.js";
import * as pgCompile from "../../src/postgres/compile/index.js";
import { boot, caller, isCheck, opIndexOf, program, runProcedure, runView, site, useCompileSide } from "../../src/testing/harness.js";
import { PG_URL, freshSchema } from "./engine.js";

const engine = async (timeZone?: string) => {
  const db = await freshSchema();
  return { ...db, storage: postgresStorage({ connect: db.connect, timeZone }), driver: pgDatabaseDriver(db.connect) };
};
const planOf = (schemas: Record<string, any>, fingerprint: string) => ({ version: RUNTIME_PLAN_VERSION, dialect: { name: pgCompile.name, version: pgCompile.version }, fingerprint, views: {}, procedures: {}, triggers: {},
  schemas: Object.fromEntries(Object.entries(schemas).map(([n, d]) => [n, { ...d, name: n, names: {}, schema: { type: "object" } }])) });

it.skipIf(!PG_URL)("a second boot reads only the fingerprint; a new field is added, a changed type and a foreign table are blocked", async () => {
  const e = await engine();
  try {
    const notes = { scope: "owner", fields: { title: "text" }, unique: [["title"]] };
    await e.storage.prepare(planOf({ notes }, "f1"));
    await e.driver.batch([{ sql: "INSERT INTO notes (id, owner, created_at, title) VALUES ('n1', 'o1', now(), 'a')" }]);
    await e.storage.prepare(planOf({ notes }, "f1"));
    await e.storage.prepare(planOf({ notes: { ...notes, fields: { title: "text", stars: "integer" } } }, "f2"));
    const [cols] = await e.driver.batch([{ sql: "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'notes' ORDER BY ordinal_position" }]);
    expect(cols.rows.map((r) => r.column_name)).toContain("stars");
    // the scope gets no index of its own (the grammar has one lead with it); one left from before is called redundant
    const [ix] = await e.driver.batch([{ sql: "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'notes'" }]);
    expect(ix.rows.map((r) => r.indexname)).not.toContain("_mantle_scope_notes");
    await e.driver.batch([{ sql: "CREATE INDEX _mantle_scope_notes ON notes (owner)" }]);
    expect((await convergeStorage(e.connect, { notes: { ...notes, fields: { title: "text", stars: "integer" } } }, { fingerprint: "f2b" })).undeclared.map((u) => u.message))
      .toEqual(["index _mantle_scope_notes is redundant: a declared index leads with owner; drop it by hand"]);
    await expect(e.storage.prepare(planOf({ notes: { ...notes, fields: { title: "integer" } } }, "f3"))).rejects.toThrow(/notes\.title is text, the plan says int8/);
    await e.driver.batch([{ sql: "CREATE TABLE theirs (id text)" }]);
    await expect(e.storage.prepare(planOf({ theirs: { fields: { x: "text" } } }, "f4"))).rejects.toThrow(/Mantle did not create it/);
  } finally { await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a check names its Schema and expression; a unique conflict names its op; values read from jsonb_array_elements are cast to their columns", async () => {
  const e = await engine();
  useCompileSide(pgCompile);
  try {
    const s = site(await boot(e));
    const write = (sql: string, inputs = {}, input = {}) => program("procedure", sql, inputs).then((p) => runProcedure(s, p, caller(input)));
    const err = await write("UPDATE items SET stock = -1 WHERE id = 'a'").catch((x) => x);
    expect(isCheck(err)).toBe(true);
    expect(err.message).toBe("CHECK items: stock >= 0");
    const dup = await write("INSERT INTO settings (key, value) VALUES ('fresh', '1'); INSERT INTO settings (key, value) VALUES ('theme', '2')").catch((x) => x);
    expect(dup).toBeInstanceOf(DiagnosticError);
    expect(opIndexOf(dup)).toBe(1);
    const { rows } = await write("INSERT INTO orders (item_id, qty, total) SELECT j.value ->> 'item', j.value ->> 'qty', j.value ->> 'total' FROM jsonb_array_elements(input.rows) j RETURNING item_id, qty, total",
      { rows: "json" }, { rows: [{ item: "a", qty: 2, total: "1.50" }, { item: "b", qty: "3", total: 2 }] });
    expect(rows[0]).toEqual([{ item_id: "a", qty: 2, total: "1.50" }, { item_id: "b", qty: 3, total: "2.00" }]);
  } finally { useCompileSide(undefined); await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("date_trunc and extract compute in the site time zone", async () => {
  const e = await engine("Asia/Taipei");
  useCompileSide(pgCompile);
  try {
    const s = site(await boot(e));
    const p = await program("view", "SELECT date_trunc('day', CAST('2026-09-30T17:30:00Z' AS timestamptz)) AS d, extract(day FROM CAST('2026-09-30T17:30:00Z' AS timestamptz)) AS dd FROM items WHERE id = 'a'");
    expect((await runView(s, p, caller())).rows).toEqual([{ d: "2026-09-30T16:00:00.000000Z", dd: 1 }]);
  } finally { useCompileSide(undefined); await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a guard holds under concurrent writers: SERIALIZABLE retries the loser, as SQLite's one writer serializes it", async () => {
  const e = await engine();
  try {
    await e.driver.batch([{ sql: "CREATE TABLE guard (k text)" }]);
    const claim = { sql: "INSERT INTO guard (k) SELECT ?1 WHERE NOT EXISTS (SELECT 1 FROM guard)" };
    await Promise.all(Array.from({ length: 8 }, (_x, i) => e.driver.batch([{ ...claim, binds: [`w${i}`] }])));
    const [n] = await e.driver.batch([{ sql: "SELECT count(*) AS n FROM guard" }]);
    expect(n.rows[0].n).toBe(1);
  } finally { await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("results do not depend on server settings or collation, and NULL sorts as PostgreSQL sorts it; SQLite's arity and ON CONFLICT rules hold", async () => {
  const e = await engine();
  useCompileSide(pgCompile);
  try {
    // a server whose settings Mantle cannot decode under is refused at boot, each with the fix its operator runs (#1379)
    const set = (sql: string) => async () => { const c = await e.connect(); await c.query({ text: sql }); return c; };
    const hostile = set("SET DateStyle = 'SQL, DMY'; SET IntervalStyle = 'iso_8601'; SET extra_float_digits = 0; SET standard_conforming_strings = off; SET statement_timeout = 0; SET TimeZone = 'America/New_York'");
    const refused = await postgresStorage({ connect: hostile }).prepare(planOf({}, "settings")).catch((x) => x);
    expect(refused.diagnostics.map((d) => [d.code, d.path, d.message.replace(/ is .*?ALTER ROLE \S+ SET /, " … ").replace(/ \(or ALTER DATABASE.*/, "")])).toEqual([
      ["STORAGE_CHANGE_BLOCKED", "storage:settings", "DateStyle … DateStyle = 'ISO, YMD'"],
      ["STORAGE_CHANGE_BLOCKED", "storage:settings", "IntervalStyle … IntervalStyle = 'postgres'"],
      ["STORAGE_CHANGE_BLOCKED", "storage:settings", "extra_float_digits … extra_float_digits = '1'"],
      ["STORAGE_CHANGE_BLOCKED", "storage:settings", "TimeZone … TimeZone = 'UTC'"],
      ["STORAGE_CHANGE_BLOCKED", "storage:settings", "standard_conforming_strings … standard_conforming_strings = 'on'"],
      ["STORAGE_CHANGE_BLOCKED", "storage:settings", "statement_timeout … statement_timeout = '10000ms'"],
    ]);
    // what differs and is harmless needs nothing: another date order, more float digits, another name for UTC
    const s = site(await boot({ ...e, storage: postgresStorage({ connect: set("SET DateStyle = 'ISO, DMY'; SET extra_float_digits = 3; SET TimeZone = 'Etc/Zulu'") }) }));
    const view = (sql: string, inputs = {}, input = {}) => program("view", sql, inputs).then((p) => runView(s, p, caller(input))).then((r) => r.rows);
    const write = (sql: string) => program("procedure", sql).then((p) => runProcedure(s, p, caller()));
    expect(await view("SELECT CAST('2026-03-08T10:00:00.5Z' AS timestamptz) AS ts, date '2026-03-08' AS d, interval '90 minutes' AS iv, 1.0 / 3 AS f FROM items WHERE id = 'a'"))
      .toEqual([{ ts: "2026-03-08T10:00:00.500000Z", d: "2026-03-08", iv: 5_400_000_000, f: 0.3333333333333333 }]);
    // PostgreSQL's own NULL order (ADR-0039): NULL last ascending, so the LIMIT picks the non-NULL rows
    expect(await view("SELECT name FROM items ORDER BY note, name LIMIT 2")).toEqual([{ name: "cherry" }, { name: "date" }]);
    // text is compared by code point whatever the database collation
    const [coll] = await e.driver.batch([{ sql: "SELECT collation_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'items' AND column_name = 'name'" }]);
    expect(coll.rows[0].collation_name).toBe("C");
    expect(await view("SELECT json_group_array(x.v) AS all FROM (SELECT json_group_array(name) AS v FROM items GROUP BY cat) x")).toEqual([{ all: [["cherry"], ["apple", "berry", "date"]] }]); // jsonb orders a shorter array first
    // PostgreSQL's own operators: ->> reads a key or an index, || a text, and a bigint is compared, not cast to bool
    expect(await view("SELECT i.tags ->> 0 AS a, 'n' || 1 AS b, i.stock <> 0 AS c FROM items i WHERE id = 'a'")).toEqual([{ a: "red", b: "n1", c: true }]);
    await expect(view("SELECT CAST(stock AS bool) AS b FROM items WHERE id = 'a'")).rejects.toThrow(/SQLSTATE 42846/);
    await expect(view("SELECT 2 * 3 || 4 AS a FROM items WHERE id = 'a'")).rejects.toThrow(/SQLSTATE 42883/);
    await write("INSERT INTO settings (key, value) VALUES ('theme', 'light') ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value");
    expect(await view("SELECT value FROM settings WHERE key = 'theme'")).toEqual([{ value: "light" }]);
    await expect(write("INSERT INTO requisitions (item_id, qty, state) SELECT id, stock, name, cat FROM items")).rejects.toThrow(/refused the statement/);
  } finally { useCompileSide(undefined); await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("an offset time zone, an unreachable server and a name PostgreSQL would truncate are refused, not misread", async () => {
  expect(() => postgresStorage({ connect: async () => { throw new Error("unused"); }, timeZone: "+08:00" })).toThrow(/IANA name/);
  const down = postgresStorage({ connect: async () => { throw Object.assign(new Error("password authentication failed"), { code: "28P01" }); } });
  const { PgStoreExecutor } = await import("../../src/postgres/executor.js");
  const ex = new PgStoreExecutor(async () => { throw Object.assign(new Error("password authentication failed"), { code: "28P01" }); }, {}, new Map());
  await expect(ex.select({ ir: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, binds: [] })).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_UNAVAILABLE" } });
  expect(down.dialect.name).toBe("@aotter/mantle/postgres");
  const e = await engine();
  try {
    await expect(e.storage.prepare(planOf({ notes: { scope: "owner", fields: { ["x".repeat(70)]: "text" } } }, "f1"))).rejects.toThrow(/at most 63 bytes/);
  } finally { await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a nested operand prints in parentheses, `AT TIME ZONE` included: PostgreSQL runs the IR, not a regrouped expression", async () => {
  await loadModule();
  const db = await freshSchema();
  const client = await db.connect();
  try {
    for (const q of ["SELECT (timestamptz '2026-01-01' AT TIME ZONE ('UT' || 'C'))::text AS v", "SELECT (('2026-01-01 00:00' || '') ::timestamp AT TIME ZONE 'UTC') < now() AS v",
      "SELECT 5 BETWEEN 0 AND (2 + 3) AS v", "SELECT (1 = 1) IN (true) AS v", "SELECT 'ab' LIKE ('a' || '%') AS v"]) {
      const printed = print((parseSync(q) as any).stmts[0].stmt);
      expect([q, (await client.query(printed)).rows[0]]).toEqual([q, (await client.query(q)).rows[0]]);
    }
  } finally { await (client as any).end?.(); await db.drop(); }
});

it.skipIf(!PG_URL)("boot creates _mantle_expect and none of the removed emulations; a database booted before keeps them, unused", async () => {
  const e = await engine();
  const fns = async () => (await e.driver.batch([{ sql: "SELECT DISTINCT proname FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname LIKE '\\_mantle\\_%' ORDER BY 1" }]))[0].rows.map((r) => r.proname);
  try {
    await e.storage.prepare(planOf({}, "f1"));
    expect(await fns()).toEqual(["_mantle_expect"]);
    // what an earlier release left behind is neither dropped nor read: a later boot converges beside it
    await e.driver.batch([{ sql: "CREATE FUNCTION _mantle_bool(x int8) RETURNS bool LANGUAGE sql AS 'SELECT x <> 0'" }]);
    await e.storage.prepare(planOf({}, "f2"));
    expect(await fns()).toEqual(["_mantle_bool", "_mantle_expect"]);
  } finally { await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a session in Asia/Taipei is refused at boot: date and instant casts would differ from UTC's", async () => {
  const e = await engine();
  try {
    const taipei = async () => { const c = await e.connect(); await c.query({ text: "SET TimeZone = 'Asia/Taipei'" }); return c; };
    const refused = await postgresStorage({ connect: taipei }).prepare(planOf({}, "tz")).catch((x) => x);
    expect(refused.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/^TimeZone is 'Asia\/Taipei'.*ALTER ROLE \S+ SET TimeZone = 'UTC'/)]);
  } finally { await e.drop(); }
}, 60_000);
