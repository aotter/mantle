import type { DatabaseDriver } from "../core/index.js";

/**
 * The few statements Better Auth's API has no call for (ADR-0035 decision 9), over the store's one port. They are portable
 * SQL, so they run on any engine a DatabaseDriver speaks: camelCase names and `"user"` quoted, binds numbered, a write's
 * count read from its `RETURNING` rows, no engine functions.
 */
export function dbOf(driver: DatabaseDriver) {
  // `?` in order becomes `?1`, `?2`: the port binds by number
  const numbered = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `?${++i}`); };
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => (await driver.batch([{ sql: numbered(sql), binds }]))[0]!.rows as T[];
  return {
    all,
    first: async <T>(sql: string, ...binds: unknown[]): Promise<T | null> => (await all<T>(sql, ...binds))[0] ?? null,
    /** A write with `RETURNING`: how many rows it wrote. */
    count: async (sql: string, ...binds: unknown[]): Promise<number> => (await all(sql, ...binds)).length,
    batch: (statements: readonly { sql: string; binds?: readonly unknown[] }[]) => driver.batch(statements.map((s) => ({ ...s, sql: numbered(s.sql) }))),
  };
}

/** The namespace a session cache keys by: the id the store minted when it was first converged (Mantle's boot state). */
export async function readStoreInstanceId(driver: DatabaseDriver): Promise<string> {
  const id = (await driver.batch([{ sql: "SELECT value FROM _mantle_boot_state WHERE key = 'instance'" }]).catch(() => undefined))?.[0]?.rows[0]?.value;
  if (typeof id !== "string") throw new Error("Mantle storage must be converged before using derivative storage.");
  return id;
}
