import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  BatchResult,
  DatabaseDriver,
  PreparedStatement,
  RunResult,
} from "../../src/domain/port/DatabaseDriver.js";
import { SqliteMigrationRunner } from "../../src/infrastructure/boot/SqliteMigrationRunner.js";
import type { EntryRow } from "../../src/domain/model/EntryRow.js";

/** Real in-memory SQLite behind the runtime's async-shaped driver contract. */
export class InMemoryDatabase implements DatabaseDriver {
  readonly executions: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  readonly migrations = new SqliteMigrationRunner(this);
  private readonly sqlite = new DatabaseSync(":memory:");
  private readonly pendingEntries: EntryRow[] = [];
  /** Legacy test seeding syntax; rows still land in native Schema tables. */
  readonly entries = (() => {
    const owner = this;
    return {
      set: (_id: string, row: EntryRow): void => owner.seedEntry(normalizeSeed(row)),
      get: (id: string): Record<string, unknown> | undefined => owner.legacyEntries().find((row) => row["id"] === id),
      values: (): IterableIterator<Record<string, unknown>> => owner.legacyEntries()[Symbol.iterator](),
      get size(): number { return owner.totalEntryCount(); },
    };
  })();

  /** Queue a native Schema-table row before or after runtime boot. */
  seedEntry(row: EntryRow): void {
    this.pendingEntries.push(structuredClone(row));
  }

  entryCount(collection: string): number {
    this.flushPendingEntries();
    return (this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quote(collection)}`).get() as { count: number }).count;
  }

  readonly siteConfig = {
    set: (key: string, value: string): void => {
      this.sqlite.exec("CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.sqlite.prepare("INSERT INTO site_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    get: (key: string): string | undefined =>
      (this.sqlite.prepare("SELECT value FROM site_config WHERE key = ?").get(key) as { value: string } | undefined)?.value,
    has: (key: string): boolean => Boolean(this.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'site_config'").get() &&
      this.sqlite.prepare("SELECT 1 FROM site_config WHERE key = ?").get(key)),
  };

  readonly appliedMigrations = (() => {
    const owner = this;
    const exists = () => Boolean(owner.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_migrations'").get());
    return {
    has: (id: string): boolean => exists() && Boolean(owner.sqlite.prepare("SELECT 1 FROM _migrations WHERE id = ?").get(id)),
    add: (id: string): void => {
      owner.sqlite.exec("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
      owner.sqlite.prepare("INSERT OR IGNORE INTO _migrations(id, applied_at) VALUES (?, ?)").run(id, Date.now());
    },
    [Symbol.iterator]: (): Iterator<string> => {
      const ids = exists() ? (owner.sqlite.prepare("SELECT id FROM _migrations ORDER BY applied_at, id").all() as { id: string }[]).map(({ id }) => id) : [];
      return ids[Symbol.iterator]();
    },
    get size(): number {
      return exists() ? Number((owner.sqlite.prepare("SELECT COUNT(*) AS count FROM _migrations").get() as { count: number }).count) : 0;
    },
  };
  })();

  prepare(sql: string): PreparedStatement {
    return new SqliteStatement(this, sql.trim(), []);
  }

  async batch(statements: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results: BatchResult[] = [];
      for (const statement of statements) {
        const result = await statement.run();
        results.push({ success: result.success, meta: result.meta });
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  execute(sql: string, params: readonly unknown[], mode: "all" | "first" | "run"): unknown {
    if (!/^\s*(?:CREATE|ALTER|DROP)\b/i.test(sql) &&
        !/\b(?:_migrations|_mantle_|sqlite_(?:schema|master)|PRAGMA)\b/i.test(sql)) this.flushPendingEntries();
    this.executions.push({ sql: normalize(sql), params });
    try {
      const statement = this.sqlite.prepare(sql);
      const values = params as readonly SQLInputValue[];
      if (mode === "all") return statement.all(...values);
      if (mode === "first") return statement.get(...values) ?? null;
      const result = statement.run(...values);
      return { success: true, meta: { changes: Number(result.changes) } } satisfies RunResult;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${sql}`, { cause: error });
    }
  }

  /** Direct access for tests that intentionally inspect SQLite plans. */
  native(): DatabaseSync {
    this.flushPendingEntries();
    return this.sqlite;
  }

  private flushPendingEntries(): void {
    if (this.pendingEntries.length > 0 && (!this.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_mantle_boot_state'").get() ||
        !this.sqlite.prepare("SELECT 1 FROM _mantle_boot_state LIMIT 1").get())) return;
    for (let index = 0; index < this.pendingEntries.length;) {
      const row = this.pendingEntries[index]!;
      if (!this.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(row.collection)) {
        index += 1;
        continue;
      }
      const columns = new Set((this.sqlite.prepare(`PRAGMA table_info(${quote(row.collection)})`).all() as Array<{ name: string }>).map(({ name }) => name));
      const fields = Object.keys(row.data).filter((field) => columns.has(field));
      const names = ["_mantle_id", "_mantle_status", "_mantle_version", "_mantle_author_id", "_mantle_created_at", "_mantle_updated_at", ...fields];
      const values = [row.id, row.status, row.version, row.authorId ?? null, row.createdAt, row.updatedAt,
        ...fields.map((field) => sqliteValue(row.data[field]))];
      this.sqlite.prepare(`INSERT OR REPLACE INTO ${quote(row.collection)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
        .run(...values as SQLInputValue[]);
      this.pendingEntries.splice(index, 1);
    }
  }

  private totalEntryCount(): number {
    this.flushPendingEntries();
    if (!this.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_mantle_schema_tables'").get()) {
      return this.pendingEntries.length;
    }
    const tables = this.sqlite.prepare("SELECT name FROM _mantle_schema_tables").all() as Array<{ name: string }>;
    return tables.reduce((total, { name }) => total + (this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get() as { count: number }).count, 0);
  }

  private legacyEntries(): Record<string, unknown>[] {
    this.flushPendingEntries();
    const pending = this.pendingEntries.map(legacySeed);
    if (!this.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_mantle_schema_tables'").get()) return pending;
    const tables = this.sqlite.prepare("SELECT name FROM _mantle_schema_tables").all() as Array<{ name: string }>;
    return [...pending, ...tables.flatMap(({ name }) => {
      const columns = (this.sqlite.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map((row) => row.name);
      const fields = columns.filter((column) => !column.startsWith("_mantle_"));
      return (this.sqlite.prepare(`SELECT * FROM ${quote(name)}`).all() as Array<Record<string, unknown>>).map((row) => ({
        id: row["_mantle_id"], collection: name, status: row["_mantle_status"], version: row["_mantle_version"],
        data: JSON.stringify(Object.fromEntries(fields.flatMap((field) => row[field] == null ? [] : [[field, row[field]]]))),
        author_id: row["_mantle_author_id"], created_at: row["_mantle_created_at"], updated_at: row["_mantle_updated_at"],
      }));
    })];
  }
}

class SqliteStatement implements PreparedStatement {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly sql: string,
    private readonly params: readonly unknown[],
  ) {}

  bind(...params: ReadonlyArray<unknown>): PreparedStatement {
    return new SqliteStatement(this.db, this.sql, params);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.db.execute(this.sql, this.params, "first") as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<readonly T[]> {
    return this.db.execute(this.sql, this.params, "all") as readonly T[];
  }

  async run(): Promise<RunResult> {
    return this.db.execute(this.sql, this.params, "run") as RunResult;
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqliteValue(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function normalizeSeed(raw: EntryRow): EntryRow {
  const row = raw as unknown as Record<string, unknown>;
  const data = typeof row["data"] === "string" ? JSON.parse(row["data"] as string) : row["data"];
  return {
    id: String(row["id"]), collection: String(row["collection"]),
    status: row["status"] as EntryRow["status"], version: Number(row["version"]),
    data: data as Record<string, unknown>, authorId: (row["authorId"] ?? row["author_id"] ?? null) as string | null,
    createdAt: Number(row["createdAt"] ?? row["created_at"]),
    updatedAt: Number(row["updatedAt"] ?? row["updated_at"]),
  };
}

function legacySeed(row: EntryRow): Record<string, unknown> {
  return {
    id: row.id, collection: row.collection, status: row.status, version: row.version,
    data: JSON.stringify(row.data), author_id: row.authorId ?? null,
    created_at: row.createdAt, updated_at: row.updatedAt,
  };
}
