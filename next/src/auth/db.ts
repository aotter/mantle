import type { DatabaseDriver } from "../core/index.js";

/**
 * Better Auth's own SQL (roles, consents, accounts) over the store's one port. `run` reports SQLite's `changes()` in the same batch,
 * because a driver's own count can include rows a trigger wrote.
 */
export function dbOf(driver: DatabaseDriver) {
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => (await driver.batch([{ sql, binds }]))[0]!.rows as T[];
  return {
    all,
    first: async <T>(sql: string, ...binds: unknown[]): Promise<T | null> => (await all<T>(sql, ...binds))[0] ?? null,
    run: async (sql: string, ...binds: unknown[]): Promise<{ meta: { changes: number } }> => {
      const [, count] = await driver.batch([{ sql, binds }, { sql: "SELECT changes() AS n" }]);
      return { meta: { changes: Number(count!.rows[0]!.n) } };
    },
    batch: (statements: readonly { sql: string; binds?: readonly unknown[] }[]) => driver.batch(statements),
  };
}
