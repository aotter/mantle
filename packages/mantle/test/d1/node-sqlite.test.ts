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

it("a paged View whose first relation is json_each loses no row (#1402)", async () => {
  const { boot, caller, program, runView, site } = await import("../../src/testing/harness.js");
  const driver = nodeSqlite();
  try {
    const s = site(await boot({ storage: sqliteStorage(driver), driver }));
    const p = await program("view", `SELECT j.value FROM json_each('["z","x","x"]') j ORDER BY j.value`);
    const got: unknown[] = [];
    let cursor: unknown[] | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await runView(s, p, caller(), { cursor, pageSize: 1 });
      got.push(...page.rows.map((r: any) => r.value));
      if (!page.next) break;
      cursor = page.next;
    }
    expect(got).toEqual(["x", "x", "z"]);
    // unaliased, alone in FROM, it is keyed by its own id
    const bare = await program("view", `SELECT value FROM json_each('["z","x","x"]') ORDER BY value`);
    const all: unknown[] = [];
    for (let next: unknown[] | undefined, i = 0; i < 6; i++) {
      const page = await runView(s, bare, caller(), { cursor: next, pageSize: 1 });
      all.push(...page.rows.map((r: any) => r.value));
      if (!(next = page.next)) break;
    }
    expect(all).toEqual(["x", "x", "z"]);
  } finally { driver.db.close(); }
});

it("a json_each native paging key is not shadowed by an output named id (#1402)", async () => {
  const { boot, caller, program, runView, site } = await import("../../src/testing/harness.js");
  const driver = nodeSqlite();
  try {
    const s = site(await boot({ storage: sqliteStorage(driver), driver }));
    for (const sql of [
      `SELECT value AS id FROM json_each('["z","x","x"]') ORDER BY id`,
      `SELECT value AS id FROM json_each('["z","x","x"]') ORDER BY value`,
      `SELECT value AS id FROM json_each('["z","x","x"]') ORDER BY 1`,
      `SELECT j.value AS id FROM json_each('["z","x","x"]') j ORDER BY id`,
    ]) {
      const p = await program("view", sql);
      for (const pageSize of [1, 2]) {
        const all: unknown[] = [];
        let cursor: unknown[] | undefined;
        for (let i = 0; i < 6; i++) {
          const page = await runView(s, p, caller(), { cursor, pageSize });
          all.push(...page.rows);
          if (!(cursor = page.next)) break;
        }
        expect(all, `${sql}; pageSize=${pageSize}`).toEqual([{ id: "x" }, { id: "x" }, { id: "z" }]);
        expect(cursor, `${sql}; pageSize=${pageSize}`).toBeUndefined();
      }
    }
  } finally { driver.db.close(); }
});

it("a deep mixed-direction native cursor seeks on its leading key while retaining tied ids", async () => {
  const { boot, caller, program, runView, site } = await import("../../src/testing/harness.js");
  const { print } = await import("../../src/d1/print.js");
  const driver = nodeSqlite();
  try {
    const b = await boot({ storage: sqliteStorage(driver), driver });
    driver.db.exec("CREATE INDEX cursor_seek ON items(owner, updated_at DESC, id ASC); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000) INSERT INTO items(id, owner, created_at, updated_at, stock) SELECT 'deep-' || printf('%05d', x), 'o1', 0, x/2, 1 FROM n; ANALYZE items");
    let statement: any;
    const s = site({ ...b, executor: { ...b.executor, select: (st) => { statement = st; return b.executor.select(st); } } });
    const p = await program("view", "SELECT id FROM items ORDER BY updated_at DESC, items.id ASC");
    const page = await runView(s, p, caller(), { pageSize: 3, cursor: [500, "deep-01000"] });
    expect(page.rows.map((row) => row.id)).toEqual(["deep-01001", "deep-00998", "deep-00999"]);
    const plan = driver.db.prepare(`EXPLAIN QUERY PLAN ${print(statement.ir)}`).all(...statement.binds);
    expect(plan.map((row) => row.detail).join("\n")).toMatch(/SEARCH items USING INDEX cursor_seek \(owner=\? AND updated_at<\?\)/);
    expect(print(statement.ir)).not.toMatch(/_k[01]"?\s+IS NULL/i);
    // The inclusive bound retains a large tie group; it does not promise constant work within that group.
    driver.db.exec("UPDATE items SET updated_at = 1 WHERE id LIKE 'deep-%'");
    const tied = await runView(s, p, caller(), { pageSize: 3, cursor: [1, "deep-19000"] });
    expect(tied.rows.map((row) => row.id)).toEqual(["deep-19001", "deep-19002", "deep-19003"]);
  } finally { driver.db.close(); }
});


it("native assertions prove expected counts without a redundant SELECT changes()", async () => {
  const { boot, caller, program, runProcedure, site } = await import("../../src/testing/harness.js");
  const driver = nodeSqlite();
  const batches: any[] = [];
  const traced = { ...driver, batch: (ss) => { batches.push(ss); return driver.batch(ss); } };
  try {
    const b = await boot({ storage: sqliteStorage(traced), driver: traced });
    batches.length = 0;
    const p = await program("procedure", "UPDATE items SET note = 'one' WHERE cat = 'y' RETURNING id; UPDATE items SET note = 'three' WHERE cat = 'x'; UPDATE items SET note = 'zero' WHERE cat = 'missing'");
    await runProcedure(site(b), { ...p, expects: [1, undefined, 0] }, caller());
    const sql = batches.at(-1).map((s) => s.sql);
    expect(sql).toHaveLength(6);
    expect(sql.filter((s) => s === "SELECT changes() AS n")).toHaveLength(1);
    expect(sql[1]).toContain("SELECT 0, changes() = 1");
    expect(sql[5]).toContain("SELECT 2, changes() = 0");
  } finally { driver.db.close(); }
});

it("SQLProcedure uses rows-only execution, preserving fallback and exact Store.write counts", async () => {
  const { compilePlan } = await import("../../src/spec/index.js");
  const { createMantleRuntime, systemCaller } = await import("../../src/core/index.js");
  const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: counters }
spec:
  title: Counters
  lifecycle: operational
  schema: { type: object, properties: { value: { type: integer } } }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: increment }
spec:
  input: { type: object }
  output: { type: object }
  handler: { sql: "UPDATE counters SET value = value + 1 RETURNING value" }
`;
  const compiled = await compilePlan({ sources: [{ sourceId: "counts:test", text: source }] });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  for (const nativeRows of [true, false]) {
    const driver = nodeSqlite();
    try {
      const base = sqliteStorage(driver);
      let full = 0, rows = 0;
      const storage = { ...base, prepare: async (plan) => {
        const prepared = await base.prepare(plan);
        const ex = prepared.executor;
        return { ...prepared, executor: {
          maxBindings: ex.maxBindings, select: (s) => ex.select(s),
          apply: (b) => { full++; return ex.apply(b); },
          ...(nativeRows ? { applyRows: (b) => { rows++; return ex.applyRows!(b); } } : {}),
        } };
      } };
      const runtime = await createMantleRuntime({ plan: compiled.plan, handlers: {}, storage });
      await runtime.store.write([{ insert: "counters", values: { value: 1 } }]);
      full = 0;
      expect(await runtime.invokeProcedure({ procedure: "increment", input: {}, caller: systemCaller("test"), cause: { kind: "internal", id: "counts" } })).toEqual({ results: [[{ value: 2 }]] });
      expect([rows, full]).toEqual(nativeRows ? [1, 0] : [0, 1]);
      expect(await runtime.store.write([{ update: "counters", set: { value: 3 }, where: { value: 2 } }])).toEqual([{ affected: 1 }]);
      expect(full).toBe(nativeRows ? 1 : 2);
    } finally { driver.db.close(); }
  }
});

it("rows-only native batches keep expectations, RETURNING and late rollback", async () => {
  const { boot, caller, program } = await import("../../src/testing/harness.js");
  const driver = nodeSqlite();
  const sent: any[] = [];
  const traced = { ...driver, batch: (ss) => { sent.push(ss); return driver.batch(ss); } };
  try {
    const b = await boot({ storage: sqliteStorage(traced), driver: traced });
    driver.db.exec("CREATE TABLE row_audit(id TEXT); CREATE TRIGGER row_audit_t AFTER UPDATE ON items BEGIN INSERT INTO row_audit VALUES(new.id); END; CREATE TRIGGER row_ignore BEFORE UPDATE ON items WHEN new.note='suppress' BEGIN SELECT RAISE(IGNORE); END");
    const p = await program("procedure", "UPDATE items SET note = 'rows-only' WHERE cat = 'y' RETURNING id; UPDATE items SET note = 'suppress' WHERE cat = 'x' RETURNING id");
    const { runProcedure } = await import("../../src/core/sql/run.js");
    const as = { caller: { kind: "user", subject: "o1", role: null, scopes: [], credential: "session", credentialId: null, clientId: null }, cause: { kind: "internal", id: "rows" }, bind: caller() };
    const env = { executor: b.executor, dialect: b.dialect, schemas: b.schemas };
    expect(await runProcedure(env, { ...p, expects: [1, 0] }, as, true)).toEqual({ rows: [[{ id: "c" }], []] });
    expect(sent.at(-1).map((s) => s.sql).some((sql) => sql === "SELECT changes() AS n")).toBe(false);
    await expect(runProcedure(env, { ...p, expects: [1, 1] }, as, true)).rejects.toMatchObject({ diagnostic: { code: "CONFLICT", conflict: { opIndex: 1 } } });
    expect(driver.db.prepare("SELECT version FROM items WHERE id='c'").get().version).toBe(2);
    expect(driver.db.prepare("SELECT count(*) AS n FROM row_audit").get().n).toBe(1);
  } finally { driver.db.close(); }
});
