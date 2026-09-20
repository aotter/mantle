import { DatabaseSync } from "node:sqlite";

/** Small D1-compatible shell for exercising the real Better Auth adapter. */
export function sqliteD1(): {
  readonly db: D1Database;
  readonly sqlite: DatabaseSync;
} {
  const sqlite = new DatabaseSync(":memory:");

  const prepare = (sql: string, bindings: unknown[] = []): D1PreparedStatement => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...bindings.map(normalize)) as T[],
      success: true,
      meta: {},
    }) as D1Result<T>,
    first: async <T>(column?: string) => {
      const row = sqlite.prepare(sql).get(...bindings.map(normalize)) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? row[column] : row) as T;
    },
    run: async <T>() => {
      const result = sqlite.prepare(sql).run(...bindings.map(normalize));
      return {
        results: [],
        success: true,
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      } as unknown as D1Result<T>;
    },
    raw: async <T>(options?: { columnNames?: boolean }) => {
      const statement = sqlite.prepare(sql);
      const rows = statement.all(...bindings.map(normalize)) as Record<string, unknown>[];
      const values = rows.map((row) => Object.values(row)) as T[][];
      return options?.columnNames
        ? [statement.columns().map((column) => column.name) as T[], ...values]
        : values;
    },
  }) as D1PreparedStatement;

  return {
    sqlite,
    db: {
      prepare,
      exec: async (sql: string) => {
        sqlite.exec(sql);
        return { count: 0, duration: 0 };
      },
      batch: async (statements: D1PreparedStatement[]) =>
        Promise.all(statements.map((statement) => statement.all())),
    } as unknown as D1Database,
  };
}

function normalize(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === null || typeof value === "string" || typeof value === "number" ||
      typeof value === "bigint" || value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}
