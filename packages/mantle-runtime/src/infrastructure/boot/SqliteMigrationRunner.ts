import type {
  DatabaseDriver,
  Migration,
  MigrationRunner,
} from "../../domain/port/DatabaseDriver.js";

type MigrationDatabase = Pick<DatabaseDriver, "prepare" | "batch">;

/** Shared SQLite migration ledger over an adapter-owned transactional driver. */
export class SqliteMigrationRunner implements MigrationRunner {
  constructor(private readonly db: MigrationDatabase) {}

  async runAll(migrations: ReadonlyArray<Migration>): Promise<void> {
    const tables = new Set((await this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('_migrations', '_mantle_migrations')`,
    ).all<{ name: string }>()).map(({ name }) => name));
    if (!tables.has("_migrations")) {
      await this.db.prepare(
        `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
      ).run();
    }

    if (tables.has("_mantle_migrations")) {
      const uncopied = await this.db.prepare(
        `SELECT legacy.id FROM _mantle_migrations legacy LEFT JOIN _migrations current ON current.id = legacy.id WHERE current.id IS NULL LIMIT 1`,
      ).first<{ id: string }>();
      if (uncopied) {
        await this.db.prepare(
          `INSERT OR IGNORE INTO _migrations (id, applied_at) SELECT id, applied_at FROM _mantle_migrations`,
        ).run();
      }
    }

    const applied = await this.db.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
    const seen = new Set(applied.map(({ id }) => id));
    for (const migration of migrations) {
      if (seen.has(migration.id)) continue;
      const statements = splitSql(migration.sql).map((sql) => this.db.prepare(sql));
      statements.push(this.db.prepare(
        `INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`,
      ).bind(migration.id, Date.now()));
      try {
        await this.db.batch(statements);
      } catch (error) {
        const winner = await this.db.prepare(
          `SELECT id FROM _migrations WHERE id = ?`,
        ).bind(migration.id).first<{ id: string }>();
        if (winner?.id !== migration.id) throw error;
      }
      seen.add(migration.id);
    }
  }
}

function splitSql(sql: string): string[] {
  // ponytail: canonical migrations have no semicolons in literals; use a lexer if that corpus changes.
  return sql.split(";").map((statement) => statement.trim()).filter(Boolean);
}
