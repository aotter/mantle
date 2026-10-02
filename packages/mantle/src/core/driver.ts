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
}
