import type { DatabaseDriver } from "../core/index.js";

/**
 * The few statements Better Auth's API has no call for (ADR-0035 decision 9), over the store's one port. They are portable
 * SQL: camelCase names and `"user"` quoted, anonymous `?` binds numbered, a write's count read from its `RETURNING` rows,
 * no engine functions.
 */
export function dbOf(driver: DatabaseDriver) {
  // each anonymous `?` outside a quoted string or name becomes `?1`, `?2`: the port binds by number
  const numbered = (sql: string) => { let i = 0; return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g, (m) => (m === "?" ? `?${++i}` : m)); };
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => (await driver.batch([{ sql: numbered(sql), binds }]))[0]!.rows as T[];
  return {
    all,
    first: async <T>(sql: string, ...binds: unknown[]): Promise<T | null> => (await all<T>(sql, ...binds))[0] ?? null,
    batch: (statements: readonly { sql: string; binds?: readonly unknown[] }[]) => driver.batch(statements.map((s) => ({ ...s, sql: numbered(s.sql) }))),
  };
}

/** The namespace a session cache keys by: the id the store minted when it was first converged (Mantle's boot state). */
export async function readStoreInstanceId(driver: DatabaseDriver): Promise<string> {
  let cause: unknown;
  const id = (await driver.batch([{ sql: "SELECT value FROM _mantle_boot_state WHERE key = 'instance'" }]).catch((e) => void (cause = e)))?.[0]?.rows[0]?.value;
  if (typeof id !== "string") throw new Error("Mantle storage must be converged before using derivative storage.", { cause });
  return id;
}
