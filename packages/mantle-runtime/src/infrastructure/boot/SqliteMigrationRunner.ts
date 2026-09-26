import type {
  DatabaseDriver,
  Migration,
  MigrationRunner,
} from "../../domain/port/DatabaseDriver.js";
import { CANONICAL_MIGRATIONS } from "./canonicalMigrations.js";

type MigrationDatabase = Pick<DatabaseDriver, "prepare" | "batch">;

/** Mantle's migration ledger. Everything Mantle owns in SQLite is `_mantle_*`. */
export const MIGRATION_LEDGER = "_mantle_migrations";
/**
 * Ledger used from v0.1.2 through 0.1.5-alpha.1. It is read to backfill
 * Mantle's own ids and never written, renamed or dropped. (v0.0.6–v0.0.8 used
 * a different `_mantle_migrations`; those databases also carry the retired
 * `entries` table and are rejected by storage preparation.)
 */
export const LEGACY_MIGRATION_LEDGER = "_migrations";

// Constant literals, not bound parameters: D1 caps a statement at 100 bindings.
const MANTLE_LEGACY_ID_SQL = `typeof(id) = 'text' AND applied_at IS NOT NULL AND (id IN (${
  CANONICAL_MIGRATIONS.map(({ id }) => `'${id.replace(/'/g, "''")}'`).join(", ")
}) OR substr(id, 1, 16) = 'schema-table-v2:' OR substr(id, 1, 12) = 'auth-schema:')`;

/** Shared SQLite migration ledger over an adapter-owned transactional driver. */
export class SqliteMigrationRunner implements MigrationRunner {
  constructor(private readonly db: MigrationDatabase) {}

  async runAll(migrations: ReadonlyArray<Migration>): Promise<void> {
    const legacy = await this.ensureLedger();
    const applied = await this.db.prepare(`SELECT id FROM ${MIGRATION_LEDGER}`).all<{ id: string }>();
    const seen = new Set(applied.map(({ id }) => id));
    for (const migration of migrations) {
      if (seen.has(migration.id)) continue;
      const statements = splitSqlStatements(migration.sql).map((sql) => this.db.prepare(sql));
      statements.push(this.db.prepare(
        `INSERT INTO ${MIGRATION_LEDGER} (id, applied_at) VALUES (?, ?)`,
      ).bind(migration.id, Date.now()));
      try {
        await this.db.batch(statements);
      } catch (error) {
        const winner = await this.db.prepare(
          `SELECT id FROM ${MIGRATION_LEDGER} WHERE id = ?`,
        ).bind(migration.id).first<{ id: string }>();
        // A pre-#1150 isolate running beside this one may have applied it into the legacy ledger.
        if (winner?.id !== migration.id && !(legacy && await this.recordLegacyWinner(migration.id))) throw error;
      }
      seen.add(migration.id);
    }
  }

  /**
   * Ensures `_mantle_migrations` exists and, when a Mantle-shaped legacy
   * `_migrations` exists, copies Mantle's own ids into it in the same
   * transaction (#1150). The copy runs on every preparation, not once: an
   * older runtime that is rolled back to, or that runs beside this one during
   * a gradual deploy, keeps writing the legacy ledger, and those ids must not
   * be replayed. Returns whether a Mantle-shaped legacy ledger exists.
   */
  private async ensureLedger(): Promise<boolean> {
    const tables = new Set((await this.db.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('${MIGRATION_LEDGER}', '${LEGACY_MIGRATION_LEDGER}')`,
    ).all<{ name: string }>()).map(({ name }) => name));
    const create = () => this.db.prepare(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    if (!tables.has(LEGACY_MIGRATION_LEDGER) || !await this.isMantleShapedLegacyLedger()) {
      if (!tables.has(MIGRATION_LEDGER)) await create().run();
      return false;
    }
    await this.db.batch([
      create(),
      this.db.prepare(`INSERT OR IGNORE INTO ${MIGRATION_LEDGER} (id, applied_at)
        SELECT id, CAST(applied_at AS INTEGER) FROM ${LEGACY_MIGRATION_LEDGER} WHERE ${MANTLE_LEGACY_ID_SQL}`),
    ]);
    return true;
  }

  /** Only a missing column means "not a Mantle ledger"; any other failure must not start an empty ledger. */
  private async isMantleShapedLegacyLedger(): Promise<boolean> {
    try {
      await this.db.prepare(`SELECT id, applied_at FROM ${LEGACY_MIGRATION_LEDGER} LIMIT 0`).all();
      return true;
    } catch (error) {
      if (!/no such column/i.test(String(error))) throw error;
      console.warn(`[mantle] ${LEGACY_MIGRATION_LEDGER} is not a Mantle ledger; leaving it untouched.`);
      return false;
    }
  }

  private async recordLegacyWinner(id: string): Promise<boolean> {
    const legacy = await this.db.prepare(
      `SELECT id FROM ${LEGACY_MIGRATION_LEDGER} WHERE id = ? AND ${MANTLE_LEGACY_ID_SQL}`,
    ).bind(id).first<{ id: string }>();
    if (legacy?.id !== id) return false;
    await this.db.prepare(`INSERT OR IGNORE INTO ${MIGRATION_LEDGER} (id, applied_at)
      SELECT id, CAST(applied_at AS INTEGER) FROM ${LEGACY_MIGRATION_LEDGER} WHERE id = ?`).bind(id).run();
    return true;
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let state: "sql" | "single" | "double" | "backtick" | "bracket" | "line-comment" | "block-comment" = "sql";
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (state === "line-comment") {
      if (char === "\n") state = "sql";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") { state = "sql"; i += 1; }
      continue;
    }
    if (state !== "sql") {
      const closing = state === "single" ? "'" : state === "double" ? '"' : state === "backtick" ? "`" : "]";
      if (char === closing) {
        if (state !== "bracket" && next === closing) i += 1;
        else state = "sql";
      }
      continue;
    }
    if (char === "-" && next === "-") { state = "line-comment"; i += 1; continue; }
    if (char === "/" && next === "*") { state = "block-comment"; i += 1; continue; }
    if (char === "'") { state = "single"; continue; }
    if (char === '"') { state = "double"; continue; }
    if (char === "`") { state = "backtick"; continue; }
    if (char === "[") { state = "bracket"; continue; }
    if (char === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  if (state !== "sql" && state !== "line-comment") throw new Error("Unterminated SQLite migration token.");
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
