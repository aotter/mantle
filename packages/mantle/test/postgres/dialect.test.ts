// @ts-nocheck test code over loosely typed IR and rows
/**
 * What the compliance suite leaves to each dialect, checked for PostgreSQL: convergence on a second boot and on a plan change,
 * the CHECK message, a unique conflict's op, guards under concurrent writers, the site time zone, and values written from
 * json_each, which SQLite's affinity coerced and PostgreSQL needs cast.
 */
import { expect, it } from "vitest";
import { RUNTIME_PLAN_VERSION } from "../../src/spec/index.js";
import { DiagnosticError } from "../../src/spec/kernel/index.js";
import { pgDatabaseDriver, postgresStorage } from "../../src/postgres/index.js";
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
    await expect(e.storage.prepare(planOf({ notes: { ...notes, fields: { title: "integer" } } }, "f3"))).rejects.toThrow(/notes\.title is text, the plan says int8/);
    await e.driver.batch([{ sql: "CREATE TABLE theirs (id text)" }]);
    await expect(e.storage.prepare(planOf({ theirs: { fields: { x: "text" } } }, "f4"))).rejects.toThrow(/Mantle did not create it/);
  } finally { await e.drop(); }
}, 60_000);

it.skipIf(!PG_URL)("a check names its Schema and expression; a unique conflict names its op; json_each values are cast to their columns", async () => {
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
    const { rows } = await write("INSERT INTO orders (item_id, qty, total) SELECT j.value ->> 'item', j.value ->> 'qty', j.value ->> 'total' FROM json_each(input.rows) j RETURNING item_id, qty, total",
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
