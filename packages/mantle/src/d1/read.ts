import type { DatabaseDriver, SqlStatement } from "../core/driver.js";

/** One SELECT uses the native read port; older batch-only drivers keep their fallback. */
export async function readRows(driver: DatabaseDriver, statement: SqlStatement) {
  return driver.all ? driver.all(statement) : (await driver.batch([statement]))[0]!.rows;
}
