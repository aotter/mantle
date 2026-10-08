import type { DatabaseDriver } from "../core/index.js";

/**
 * The few statements Better Auth's API has no call for (ADR-0035 decision 9), over the store's one port. They are portable
 * SQL: camelCase names and `"user"` quoted, anonymous `?` binds numbered, a write's count read from its `RETURNING` rows,
 * no engine functions.
 */
export function dbOf(driver: DatabaseDriver) {
  // each anonymous `?` outside a quoted string or name becomes `?1`, `?2`: the port binds by number
  const numbered = (sql: string) => { let i = 0; return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g, (m) => (m === "?" ? `?${++i}` : m)); };
  // a statement that writes (`RETURNING`) goes through the batch, one transaction; a read takes the driver's plain read path
  const returning = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => (await driver.batch([{ sql: numbered(sql), binds }]))[0]!.rows as T[];
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> =>
    (driver.all ? await driver.all({ sql: numbered(sql), binds }) : await returning(sql, ...binds)) as T[];
  return {
    all,
    returning,
    first: async <T>(sql: string, ...binds: unknown[]): Promise<T | null> =>
      (driver.first ? await driver.first({ sql: numbered(sql), binds }) : (await returning<T>(sql, ...binds))[0] ?? null) as T | null,
    batch: (statements: readonly { sql: string; binds?: readonly unknown[] }[]) => driver.batch(statements.map((s) => ({ ...s, sql: numbered(s.sql) }))),
  };
}

/** The namespace a session cache keys by: the id the store minted when it was first converged (Mantle's boot state). */
export async function readStoreInstanceId(driver: DatabaseDriver): Promise<string> {
  let cause: unknown;
  const id = (await dbOf(driver).first<{ value: unknown }>("SELECT value FROM _mantle_boot_state WHERE key = 'instance'").catch((e) => void (cause = e)))?.value;
  if (typeof id !== "string") throw new Error("Mantle storage must be converged before using derivative storage.", { cause });
  return id;
}
