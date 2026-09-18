import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { EntryVersionConflict, SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import {
  runStorageConformance,
  type StorageConformanceOptions,
} from "@aotter/mantle-runtime/testing/storage";
import { BunDatabaseDriver } from "../src/index.js";

const create: StorageConformanceOptions["create"] = async (plan) => {
  const database = new Database(":memory:");
  try {
    const adapter = new SqliteMantleStorageAdapter(new BunDatabaseDriver(database), {
      locales: ["en", "zh-TW", "ja"],
    });
    return { storage: await adapter.prepare(plan), cleanup: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
};

test("the public storage contract passes against real SQLite through Bun", async () => {
  const report = await runStorageConformance({ create });
  expect(report.failures).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(7);
});

test("detects swallowed OCC errors and cleans up every isolated case", async () => {
  let cleanups = 0;
  const report = await runStorageConformance({
    async create(plan) {
      const fixture = await create(plan);
      const entries = fixture.storage.entries;
      const update = entries.update.bind(entries);
      entries.update = async (args) => {
        try {
          return await update(args);
        } catch (error) {
          if (!(error instanceof EntryVersionConflict)) throw error;
          return (await entries.get({ id: args.id, collection: args.collection }))!;
        }
      };
      return {
        storage: fixture.storage,
        async cleanup() { cleanups += 1; await fixture.cleanup(); },
      };
    },
  });
  expect(report.ok).toBe(false);
  expect(report.failures).toEqual([{
    check: "entries.version-conflicts", phase: "assertion",
    message: "one concurrent update wins: expected 1, received 2",
  }]);
  expect(cleanups).toBe(report.checks.length);
});

test("reports setup and cleanup failures separately and continues later cases", async () => {
  let attempts = 0;
  const report = await runStorageConformance({
    async create(plan) {
      const attempt = ++attempts;
      if (attempt === 1) throw new Error("cannot prepare fixture");
      const fixture = await create(plan);
      return {
        storage: fixture.storage,
        async cleanup() {
          await fixture.cleanup();
          if (attempt === 2) throw new Error("cannot clean fixture");
        },
      };
    },
  });
  expect(report.ok).toBe(false);
  expect(report.failures).toEqual([
    { check: "entries.crud", phase: "setup", message: "cannot prepare fixture" },
    { check: "entries.version-conflicts", phase: "cleanup", message: "cannot clean fixture" },
  ]);
  expect(attempts).toBe(report.checks.length);
});

test("detects persistence fields leaking from a public reader", async () => {
  const report = await runStorageConformance({
    async create(plan) {
      const fixture = await create(plan);
      const entries = fixture.storage.entries;
      entries.readById = (key) => entries.get(key);
      return fixture;
    },
  });
  expect(report.ok).toBe(false);
  expect(report.failures).toEqual([{
    check: "entries.read-helpers", phase: "assertion",
    message: 'public projection excludes persistence fields: expected [], received ["authorId"]',
  }]);
});
