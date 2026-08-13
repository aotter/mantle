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
  it("keeps an up-to-date migration ledger read-only during boot", async () => {
    const writes: string[] = [];
    const batch = vi.fn();
    const prepare = (sql: string): D1PreparedStatement => ({
      bind: () => prepare(sql),
      run: async () => {
        writes.push(sql);
        return { success: true, meta: {} } as D1Result;
      },
      all: async <T>() => ({
        success: true,
        meta: {},
        results: (sql.includes("sqlite_master")
          ? [{ name: "_migrations" }]
          : [{ id: migration.id }]) as T[],
      }) as D1Result<T>,
      first: async () => null,
    }) as D1PreparedStatement;
    const driver = new D1DatabaseDriver({
      prepare: vi.fn(prepare),
      batch,
    } as unknown as D1Database);

    await expect(driver.migrations.runAll([migration])).resolves.toBeUndefined();

    expect(writes).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
  });

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

describe("D1DatabaseDriver query observer", () => {
  it("reports D1 metadata without changing the default driver contract", async () => {
    const meta = {
      duration: 2,
      size_after: 0,
      rows_read: 7,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    };
    const statement = (sql: string): D1PreparedStatement => ({
      bind: () => statement(sql),
      first: async () => {
        throw new Error("observer mode should use all() so D1 metadata is available");
      },
      all: async <T>() => ({ success: true, meta, results: [{ id: "one" }] as T[] }),
      run: async () => ({ success: true, meta }),
    }) as D1PreparedStatement;
    const db = {
      prepare: vi.fn((sql: string) => statement(sql)),
      batch: vi.fn(async (statements: readonly D1PreparedStatement[]) =>
        statements.map(() => ({ success: true, meta, results: [] }))),
    } as unknown as D1Database;
    const observed: Array<{ sql: string; rowsRead: number }> = [];
    const driver = new D1DatabaseDriver(db, ({ sql, rowsRead }) => {
      observed.push({ sql, rowsRead });
    });

    await expect(driver.prepare("SELECT one").first<{ id: string }>()).resolves.toEqual({ id: "one" });
    await driver.prepare("SELECT many").all();
    await driver.prepare("UPDATE one").run();
    await driver.batch([driver.prepare("SELECT batch")]);

    expect(observed).toEqual([
      { sql: "SELECT one", rowsRead: 7 },
      { sql: "SELECT many", rowsRead: 7 },
      { sql: "UPDATE one", rowsRead: 7 },
      { sql: "SELECT batch", rowsRead: 7 },
    ]);
  });
});
