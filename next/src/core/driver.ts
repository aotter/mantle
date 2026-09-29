/** The SQLite-family port under SqliteStoreExecutor: D1, Bun and libSQL each wrap their native driver to this. */
export interface SqlStatement {
  readonly sql: string;
  /** Bound in `?n` order. */
  readonly binds?: readonly unknown[];
}

export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly changes: number;
}

export interface DatabaseDriver {
  /** Every statement in order, all or nothing (a D1 `batch`). Throws the engine's error text when one fails. */
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
}
