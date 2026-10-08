/** The SQLite-family port under SqliteStoreExecutor: D1, Bun and libSQL each wrap their native driver to this. */
export interface SqlStatement {
  readonly sql: string;
  /** Bound in `?n` order. */
  readonly binds?: readonly unknown[];
}

export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface DatabaseDriver {
  /**
   * Every statement in order, all or nothing (a D1 `batch`). When one fails, rethrows the engine's error unchanged, with its
   * code (`code` or `errcode`): the executor tells a refused statement from one that never reached the engine by it.
   */
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
  /**
   * One read statement, outside any transaction: the engine's plain read path, one round trip. Optional: a driver without it
   * has its reads go through `batch`. Only a single-statement SELECT may use it; a write or a read-modify-write goes through `batch`.
   */
  first?(statement: SqlStatement): Promise<Record<string, unknown> | null>;
  /** `first` for every row. */
  all?(statement: SqlStatement): Promise<readonly Record<string, unknown>[]>;
}
