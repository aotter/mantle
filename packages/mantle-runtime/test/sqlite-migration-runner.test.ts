import { describe, expect, it, vi } from "vitest";
import type { Migration } from "../src/domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "../src/infrastructure/boot/canonicalMigrations.js";
import { SqliteMigrationRunner } from "../src/infrastructure/boot/SqliteMigrationRunner.js";
import { InMemoryDatabase } from "./fakes/database.js";

const tables = (db: InMemoryDatabase) =>
  (db.native().prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%migrations' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => name);
const ledger = (db: InMemoryDatabase, table = "_mantle_migrations") =>
  db.native().prepare(`SELECT id, applied_at FROM ${table} ORDER BY id`).all() as { id: string; applied_at: number }[];

/** Fails if applied twice, like the canonical ADD COLUMN migrations. */
const nonIdempotent: Migration = { id: "0005-store-instance-id", description: "", sql: "ALTER TABLE probe ADD COLUMN extra TEXT" };

describe("SqliteMigrationRunner ledger (#1150)", () => {
  it("records migrations in _mantle_migrations on a fresh database", async () => {
    const db = new InMemoryDatabase();
    await db.migrations.runAll([{ id: "0001-init", description: "", sql: "CREATE TABLE probe (id TEXT)" }]);
    expect(tables(db)).toEqual(["_mantle_migrations"]);
    expect(ledger(db).map(({ id }) => id)).toEqual(["0001-init"]);
  });

  it("backfills Mantle ids from a legacy _migrations without re-running them or touching it", async () => {
    const db = new InMemoryDatabase();
    const legacy = [
      ...CANONICAL_MIGRATIONS.map(({ id }, i) => ({ id, applied_at: 1_000 + i })),
      { id: "schema-table-v2:table:706f737473", applied_at: 2_000 },
      { id: "auth-schema:1:abc", applied_at: 3_000 },
    ];
    db.native().exec("CREATE TABLE probe (id TEXT, extra TEXT)");
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const row of legacy) db.native().prepare("INSERT INTO _migrations VALUES (?, ?)").run(row.id, row.applied_at);

    await db.migrations.runAll([nonIdempotent]);

    expect(ledger(db)).toEqual([...legacy].sort((a, b) => a.id.localeCompare(b.id)));
    expect(ledger(db, "_migrations")).toEqual([...legacy].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("leaves application rows in a shared _migrations where they are", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    db.native().prepare("INSERT INTO _migrations VALUES (?, ?), (?, ?)").run("0001-init", 1, "app-0001-users", 2);

    await db.migrations.runAll([]);

    expect(ledger(db).map(({ id }) => id)).toEqual(["0001-init"]);
    expect(ledger(db, "_migrations").map(({ id }) => id)).toEqual(["0001-init", "app-0001-users"]);
  });

  it("does not copy a look-alike id that only matches a prefix case-insensitively", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    db.native().prepare("INSERT INTO _migrations VALUES (?, ?), (?, ?)").run("SCHEMA-TABLE-V2:x", 1, "auth-schema-app", 2);

    await db.migrations.runAll([]);

    expect(ledger(db)).toEqual([]);
  });

  it("ignores a foreign-shaped _migrations and starts an empty ledger", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE _migrations (name TEXT, run_on TEXT)");
    db.native().prepare("INSERT INTO _migrations VALUES (?, ?)").run("0001-init", "yesterday");

    await db.migrations.runAll([{ id: "0001-init", description: "", sql: "CREATE TABLE probe (id TEXT)" }]);

    expect(ledger(db).map(({ id }) => id)).toEqual(["0001-init"]);
    expect(db.native().prepare("SELECT name, run_on FROM _migrations").all()).toEqual([{ name: "0001-init", run_on: "yesterday" }]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("is idempotent across boots once the ledger exists", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE probe (id TEXT)");
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    await db.migrations.runAll([nonIdempotent]);
    await db.migrations.runAll([nonIdempotent]);
    expect(ledger(db).map(({ id }) => id)).toEqual(["0005-store-instance-id"]);
  });

  it("does not replay ids an older runtime wrote to the legacy ledger after a rollback", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE probe (id TEXT)");
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    await db.migrations.runAll([]);
    // Rolled back to 0.1.5-alpha.1, which applies a new column into the legacy ledger.
    db.native().exec("ALTER TABLE probe ADD COLUMN extra TEXT");
    db.native().prepare("INSERT INTO _migrations VALUES (?, ?)").run(nonIdempotent.id, 5);
    // Rolled forward again.
    await db.migrations.runAll([nonIdempotent]);
    expect(ledger(db)).toEqual([{ id: nonIdempotent.id, applied_at: 5 }]);
  });

  it("accepts a concurrent pre-#1150 isolate as the winner of the same migration", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE probe (id TEXT)");
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    let raced = false;
    let batches = 0;
    const runner = new SqliteMigrationRunner({
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        // Batch 1 creates and backfills the ledger; batch 2 is the migration itself.
        if (++batches === 2) {
          raced = true;
          // The older isolate lands the same migration between our backfill and our batch.
          db.native().exec("ALTER TABLE probe ADD COLUMN extra TEXT");
          db.native().prepare("INSERT INTO _migrations VALUES (?, ?)").run(nonIdempotent.id, 7);
        }
        return db.batch(statements);
      },
    });
    const winner = vi.spyOn(runner as unknown as { recordLegacyWinner: (id: string) => Promise<boolean> }, "recordLegacyWinner");
    await runner.runAll([nonIdempotent]);
    expect(raced).toBe(true);
    expect(winner).toHaveBeenCalledOnce();
    expect(ledger(db)).toEqual([{ id: nonIdempotent.id, applied_at: 7 }]);
  });

  it("copies Mantle rows whose applied_at the application's table stored as text", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE probe (id TEXT, extra TEXT)");
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT)");
    db.native().prepare("INSERT INTO _migrations VALUES (?, ?)").run(nonIdempotent.id, "1790000000000");
    await db.migrations.runAll([nonIdempotent]);
    expect(ledger(db)).toEqual([{ id: nonIdempotent.id, applied_at: 1790000000000 }]);
  });

  it("rethrows a transient failure instead of starting an empty ledger", async () => {
    const db = new InMemoryDatabase();
    db.native().exec("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const runner = new SqliteMigrationRunner({
      prepare: (sql) => sql.includes("LIMIT 0")
        ? { ...db.prepare(sql), all: async () => { throw new Error("D1_ERROR: Network connection lost."); } } as ReturnType<InMemoryDatabase["prepare"]>
        : db.prepare(sql),
      batch: (statements) => db.batch(statements),
    });
    await expect(runner.runAll([nonIdempotent])).rejects.toThrow(/Network connection lost/);
    expect(tables(db)).toEqual(["_migrations"]);
  });
});
