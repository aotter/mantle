import { expect, it } from "vitest";
import { d1Driver } from "../../src/cloudflare/index.js";

/** A D1 that records which entry point each statement used. */
const fake = () => {
  const used: string[] = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => (used.push(`first ${sql} ${JSON.stringify(binds)}`), sql.includes("none") ? null : { id: 1 }),
    all: async () => (used.push(`all ${sql}`), { results: [{ id: 1 }, { id: 2 }] }),
  });
  return { used, db: { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => (used.push(`batch ${s.length}`), s.map(() => ({ results: [{ id: 1 }] }))) } };
};

it("a single read uses prepare().first / .all, not a batch; a batch is still a batch", async () => {
  const { db, used } = fake();
  const driver = d1Driver(db);
  expect(await driver.first!({ sql: "SELECT id FROM t WHERE id = ?1", binds: [7] })).toEqual({ id: 1 });
  expect(await driver.first!({ sql: "SELECT none" })).toBeNull();
  expect(await driver.all!({ sql: "SELECT id FROM t" })).toEqual([{ id: 1 }, { id: 2 }]);
  expect(used).toEqual(['first SELECT id FROM t WHERE id = ?1 [7]', "first SELECT none []", "all SELECT id FROM t"]);
  await driver.batch([{ sql: "DELETE FROM t" }]);
  expect(used.at(-1)).toBe("batch 1");
});
