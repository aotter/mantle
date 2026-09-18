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
    const ledger = await this.db.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '_migrations'`,
    ).first<{ name: string }>();
    if (!ledger) {
      await this.db.prepare(
        `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
      ).run();
    }

    const applied = await this.db.prepare(`SELECT id FROM _migrations`).all<{ id: string }>();
    const seen = new Set(applied.map(({ id }) => id));
    for (const migration of migrations) {
      if (seen.has(migration.id)) continue;
      const statements = splitSqlStatements(migration.sql).map((sql) => this.db.prepare(sql));
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
