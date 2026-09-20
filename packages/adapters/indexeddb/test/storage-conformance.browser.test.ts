import { runStorageConformance } from "@aotter/mantle-runtime/testing/storage";
import { expect, it } from "vitest";
import { IndexedDbMantleStorageAdapter } from "../src/index.js";

it("passes the public storage conformance contract in Chrome", async () => {
  const report = await runStorageConformance({
    async create(plan) {
      const adapter = new IndexedDbMantleStorageAdapter({
        databaseName: `mantle-conformance-${crypto.randomUUID()}`,
      });
      try {
        return { storage: await adapter.prepare(plan), cleanup: () => adapter.deleteDatabase() };
      } catch (error) {
        await adapter.deleteDatabase();
        throw error;
      }
    },
  });
  expect(report.failures).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(7);
});
