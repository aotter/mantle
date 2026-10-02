// @ts-nocheck test code over loosely typed rows
/**
 * The compliance suite on a second SQLite driver: node:sqlite, which reports errors as bun:sqlite and libSQL do (the code
 * beside the message, not inside it as D1 writes it). A driver difference fails here instead of in a service.
 */
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { DatabaseDriver } from "../../src/core/driver.js";
import { sqliteStorage } from "../../src/d1/index.js";
import { runStorageConformance } from "../../src/testing/index.js";
import { SqliteStoreExecutor } from "../../src/d1/executor.js";

/** A DatabaseDriver over node:sqlite: one transaction per batch, the engine's error rethrown unchanged. */
export function nodeSqlite(path = ":memory:"): DatabaseDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  return {
    db,
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = statements.map(({ sql, binds }) => {
          const s = db.prepare(sql);
          const args = (binds ?? []).map((b) => (typeof b === "boolean" ? Number(b) : b ?? null));
          return { rows: s.columns().length ? s.all(...args).map((r) => ({ ...r })) : (s.run(...args), []) };
        });
        db.exec("COMMIT");
        return out;
      } catch (e) {
        // SQLite has already rolled back after FULL, IOERR or an interrupt; the original error is the one to report
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    },
  };
}

it("the compliance suite passes on node:sqlite", async () => {
  const report = await runStorageConformance({
    create: async () => {
      const driver = nodeSqlite();
      return { storage: sqliteStorage(driver), driver, cleanup: () => driver.db.close() };
    },
  });
  expect(report.failures).toEqual([]);
}, 300_000);

it("a refused write is classified by the driver's code, not by D1's message text", async () => {
  const driver = nodeSqlite();
  driver.db.exec("CREATE TABLE t (a INTEGER) STRICT; CREATE TRIGGER c BEFORE INSERT ON t WHEN new.a < 0 BEGIN SELECT RAISE(ABORT, 'MANTLE_CHECK t: a >= 0'); END; CREATE TABLE _mantle_assert (op INTEGER, ok INTEGER)");
  const ex = new SqliteStoreExecutor(driver);
  const insert = (n: number) => ({ ir: { InsertStmt: { relation: { relname: "t", inh: true, relpersistence: "p" }, cols: [{ ResTarget: { name: "a" } }], selectStmt: { SelectStmt: { valuesLists: [{ List: { items: [{ A_Const: { ival: { ival: n } } }] } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, override: "OVERRIDING_NOT_SET" } }, binds: [] });
  await expect(ex.apply([insert(-1)])).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", message: "CHECK t: a >= 0" } });
  await expect(ex.select({ ir: { SelectStmt: { targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } }], fromClause: [{ RangeVar: { relname: "nope", inh: true, relpersistence: "p" } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, binds: [] }))
    .rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED" } });
});

it("each driver's error shape: bun's plain SQLITE_ERROR is refused; busy, full and I/O are not the caller's input", async () => {
  const failing = (error: Error): DatabaseDriver => ({ batch: async () => { throw error; } });
  const select = { ir: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, binds: [] };
  const code = (error: Error) => new SqliteStoreExecutor(failing(error)).apply([select]).catch((e) => e.diagnostic.code);
  const bun = (message: string, extra: object) => Object.assign(new Error(message), { name: "SQLiteError" }, extra);
  expect(await code(bun("no such table: nope", { errno: 1 }))).toBe("INPUT_VALIDATION_FAILED");
  expect(await code(bun("UNIQUE constraint failed: t.a", { errno: 2067, code: "SQLITE_CONSTRAINT_UNIQUE" }))).toBe("CONFLICT");
  expect(await code(bun("database is locked", { errno: 5, code: "SQLITE_BUSY" }))).toBe("OUTCOME_UNKNOWN");
  expect(await code(Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 4874 }))).toBe("OUTCOME_UNKNOWN");
  expect(await code(new Error("D1_ERROR: Network connection lost."))).toBe("OUTCOME_UNKNOWN");
  expect(await code(new Error("D1_ERROR: no such table: nope: SQLITE_ERROR"))).toBe("INPUT_VALIDATION_FAILED");
});
