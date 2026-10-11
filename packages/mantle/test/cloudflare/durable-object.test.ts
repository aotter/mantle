// @ts-nocheck test code over loosely typed rows
/**
 * Real SQLite-backed Durable Objects in local workerd (#1395): the storage conformance suite, and how the engine's constraint
 * errors reach the executor. This is local-workerd evidence, not production.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { LocalDurableObjects } from "../../src/cloudflare/testing/durable-object.js";
import { SqliteStoreExecutor } from "../../src/d1/executor.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { runStorageConformance } from "../../src/testing/index.js";

let host: LocalDurableObjects;
beforeAll(async () => { host = await LocalDurableObjects.start(); }, 60_000);
afterAll(() => host?.dispose());

it("the storage conformance suite passes on Durable Object SQLite", async () => {
  const report = await runStorageConformance({
    create: async () => {
      const d = host.open();
      return { storage: sqliteStorage(d, { maxBindings: 100 }), driver: d, cleanup: async () => {} };
    },
  });
  expect(report.failures).toEqual([]);
  expect(report.checks.length).toBeGreaterThan(50);
}, 300_000);

const rel = { relname: "t", inh: true, relpersistence: "p" };
const cnst = (v: unknown) => (v === null ? { A_Const: { isnull: true } } : { A_Const: { ival: { ival: v } } });
const col = (name: string) => ({ ColumnRef: { fields: [{ String: { sval: name } }] } });
const insert = (cols: string[], values: unknown[]) => ({
  ir: { InsertStmt: { relation: rel, cols: cols.map((name) => ({ ResTarget: { name } })), selectStmt: { SelectStmt: { valuesLists: [{ List: { items: values.map((v) => (typeof v === "string" ? { A_Const: { sval: { sval: v } } } : cnst(v))) } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, override: "OVERRIDING_NOT_SET" } },
  binds: [],
});
// UPDATE t SET n = 1 WHERE id = 999
const update = { ir: { UpdateStmt: { relation: rel, targetList: [{ ResTarget: { name: "n", val: cnst(1) } }], whereClause: { A_Expr: { kind: "AEXPR_OP", name: [{ String: { sval: "=" } }], lexpr: col("id"), rexpr: cnst(999) } } } }, binds: [], expect: 1 };
const selectFrom = (relname: string) => ({ ir: { SelectStmt: { targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } }], fromClause: [{ RangeVar: { relname, inh: true, relpersistence: "p" } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, binds: [] });

it("the engine's own constraint error, as Durable Object SQL throws it", async () => {
  const d = host.open();
  await d.exec("CREATE TABLE r (u TEXT UNIQUE)", "INSERT INTO r VALUES ('a')");
  const raw = await d.raw("INSERT INTO r VALUES ('a')").catch((x) => x);
  const viaDriver = await d.batch([{ sql: "INSERT INTO r VALUES ('a')" }]).catch((x) => x);
  // observed in workerd (wrangler 4.137 / miniflare 5.20260921): a plain Error, no code field, the SQLite code inside the message,
  // "UNIQUE constraint failed: r.u: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)". So the executor's text rule
  // already classifies it as a refusal and the driver maps nothing.
  expect(raw.message).toMatch(/UNIQUE constraint failed: r\.u: SQLITE_CONSTRAINT/);
  expect(viaDriver.message).toBe(raw.message);
});

it("constraint failures in a Durable Object are refusals, classified as on D1", async () => {
  const d = host.open();
  await d.exec(
    // src/d1/storage.ts SYSTEM_DDL: the _mantle_assert table and trigger
    "CREATE TABLE IF NOT EXISTS _mantle_assert (op INTEGER, ok INTEGER)",
    "CREATE TRIGGER IF NOT EXISTS _mantle_assert_t BEFORE INSERT ON _mantle_assert BEGIN SELECT CASE WHEN new.ok IS NOT 1 THEN RAISE(ABORT, 'CONFLICT op=' || new.op) ELSE RAISE(IGNORE) END; END",
    "CREATE TABLE parent (id INTEGER PRIMARY KEY)",
    "CREATE TABLE t (id INTEGER PRIMARY KEY, u TEXT UNIQUE, n INTEGER NOT NULL DEFAULT 0, c INTEGER CHECK (c >= 0), p INTEGER REFERENCES parent(id), a INTEGER) STRICT",
    "CREATE TRIGGER chk BEFORE INSERT ON t WHEN new.a < 0 BEGIN SELECT RAISE(ABORT, 'MANTLE_CHECK t: a >= 0'); END",
  );
  const ex = new SqliteStoreExecutor(d, 100);
  const count = async () => (await d.all({ sql: "SELECT count(*) AS c FROM t" }))[0].c;
  const diag = (diagnostic: object) => ({ diagnostic });

  await ex.apply([insert(["u"], ["x"])]);
  await expect(ex.apply([insert(["u"], ["x"])])).rejects.toMatchObject(diag({ code: "CONFLICT", conflict: { reason: "unique", opIndex: 0 } }));
  await expect(ex.apply([insert(["n"], [null])])).rejects.toMatchObject(diag({ code: "INPUT_VALIDATION_FAILED", message: expect.stringContaining("required column") }));
  await expect(ex.apply([insert(["a"], [-1])])).rejects.toMatchObject(diag({ code: "INPUT_VALIDATION_FAILED", message: "CHECK t: a >= 0" }));
  await expect(ex.apply([insert(["c"], [-1])])).rejects.toMatchObject(diag({ code: "INPUT_VALIDATION_FAILED", message: "The database refused the statement." }));
  await expect(ex.apply([insert(["p"], [99])])).rejects.toMatchObject(diag({ code: "INPUT_VALIDATION_FAILED" }));
  await expect(ex.apply([update])).rejects.toMatchObject(diag({ code: "CONFLICT", conflict: { reason: "expect", opIndex: 0 } }));
  await expect(ex.select(selectFrom("nope"))).rejects.toMatchObject(diag({ code: "INPUT_VALIDATION_FAILED" }));

  const before = await count();
  await expect(ex.apply([insert(["u"], ["ok"]), insert(["c"], [-1])])).rejects.toBeDefined();
  expect(await count()).toBe(before);
}, 60_000);
