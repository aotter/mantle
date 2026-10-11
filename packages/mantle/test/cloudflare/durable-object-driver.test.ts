// @ts-nocheck test code over a fake storage
import { expect, it } from "vitest";
import { SqliteStoreExecutor } from "../../src/d1/executor.js";
import { durableObjectDriver, durableObjectStorage } from "../../src/cloudflare/index.js";

function fake(err?: Error) {
  const f = {
    calls: [] as [string, unknown[]][],
    txn: 0,
    sql: {
      exec(sql: string, ...b: unknown[]) {
        f.calls.push([sql, b]);
        if (err && sql.includes("boom")) throw err;
        const rows = sql.includes("none") ? [] : [{ id: 1 }, { id: 2 }];
        let i = 0;
        return { toArray: () => rows, next: () => (i < rows.length ? { done: false, value: rows[i++] } : { done: true }) };
      },
    },
    transactionSync<T>(fn: () => T): T { f.txn++; return fn(); },
  };
  return f;
}
const select = (binds: unknown[] = []) => ({ ir: { SelectStmt: { targetList: [{ ResTarget: { val: { A_Const: { ival: { ival: 1 } } } } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } }, binds });

it("binds: a boolean is 0/1, a missing value is NULL, the rest is unchanged", async () => {
  const f = fake();
  await durableObjectDriver(f).all({ sql: "SELECT ?1", binds: [true, false, undefined, null, 0, "s", 1.5] });
  expect(f.calls[0]![1]).toEqual([1, 0, null, null, 0, "s", 1.5]);
});

it("a batch is exactly one transactionSync, in order", async () => {
  const f = fake();
  const out = await durableObjectDriver(f).batch([{ sql: "a" }, { sql: "b" }]);
  expect(f.txn).toBe(1);
  expect(f.calls.map((c) => c[0])).toEqual(["a", "b"]);
  expect(out).toEqual([{ rows: [{ id: 1 }, { id: 2 }] }, { rows: [{ id: 1 }, { id: 2 }] }]);
});

it("all and first never open a transaction; first reads one row, or null", async () => {
  const f = fake();
  const d = durableObjectDriver(f);
  expect(await d.all({ sql: "x" })).toEqual([{ id: 1 }, { id: 2 }]);
  expect(await d.first({ sql: "x" })).toEqual({ id: 1 });
  expect(await d.first({ sql: "none" })).toBeNull();
  expect(f.txn).toBe(0);
});

it("the engine's error is rethrown as the identical object", async () => {
  const err = new Error("boom");
  const d = durableObjectDriver(fake(err));
  await expect(d.batch([{ sql: "boom" }])).rejects.toBe(err);
  await expect(d.all({ sql: "boom" })).rejects.toBe(err);
  await expect(d.first({ sql: "boom" })).rejects.toBe(err);
});

it("a platform error is not a refusal: OUTCOME_UNKNOWN on apply, RESOURCE_UNAVAILABLE on select", async () => {
  const f = fake();
  f.sql.exec = () => { throw new Error("Durable Object reset because its code was updated."); };
  const ex = new SqliteStoreExecutor(durableObjectDriver(f));
  await expect(ex.apply([select()])).rejects.toMatchObject({ diagnostic: { code: "OUTCOME_UNKNOWN" } });
  await expect(ex.select(select())).rejects.toMatchObject({ diagnostic: { code: "RESOURCE_UNAVAILABLE" } });
});

it("the executor (limit 100, the default durableObjectStorage passes) refuses 101 binds, and durableObjectStorage builds an adapter", async () => {
  const d = durableObjectDriver(fake());
  const ex = new SqliteStoreExecutor(d, 100);
  await expect(ex.select(select(Array(101).fill(1)))).rejects.toMatchObject({ diagnostic: { code: "INPUT_VALIDATION_FAILED", message: expect.stringContaining("the limit is 100") } });
  expect(durableObjectStorage(fake())).toBeTruthy();
});
