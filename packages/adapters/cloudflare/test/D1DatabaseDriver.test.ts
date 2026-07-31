import type { Migration } from "@aotter/mantle-runtime";
import { describe, expect, it, vi } from "vitest";
import { D1DatabaseDriver } from "../src/bindings/D1DatabaseDriver.js";

const migration: Migration = {
  id: "schema-index-v2:column:m2c_706f737473_736c7567_54455854",
  description: "test migration",
  sql: `ALTER TABLE entries ADD COLUMN "m2c_706f737473_736c7567_54455854" TEXT`,
};

function failingD1(winnerId: string | null) {
  const batchError = new Error("migration batch lost the race");
  const batch = vi.fn(async () => {
    throw batchError;
  });

  const prepare = (sql: string, params: readonly unknown[] = []): D1PreparedStatement => ({
    bind: (...next) => prepare(sql, next),
    run: async () => ({ success: true, meta: {} }) as D1Result,
    all: async <T>() => ({ success: true, meta: {}, results: [] as T[] }) as D1Result<T>,
    first: async <T>() => {
      if (sql.includes("sqlite_master")) return null;
      if (sql === "SELECT id FROM _migrations WHERE id = ?") {
        return (winnerId === params[0] ? { id: winnerId } : null) as T | null;
      }
      throw new Error(`unexpected first(): ${sql}`);
    },
  }) as D1PreparedStatement;

  return {
    batchError,
    batch,
    db: {
      prepare: vi.fn((sql: string) => prepare(sql)),
      batch,
    } as unknown as D1Database,
  };
}

describe("D1DatabaseDriver migrations", () => {
  it("accepts a failed batch when a concurrent boot recorded the same migration", async () => {
    const fake = failingD1(migration.id);
    const driver = new D1DatabaseDriver(fake.db);

    await expect(driver.migrations.runAll([migration, migration])).resolves.toBeUndefined();

    expect(fake.batch).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed batch when no concurrent winner recorded the migration", async () => {
    const fake = failingD1(null);
    const driver = new D1DatabaseDriver(fake.db);

    await expect(driver.migrations.runAll([migration])).rejects.toBe(fake.batchError);

    expect(fake.batch).toHaveBeenCalledTimes(1);
  });
});
