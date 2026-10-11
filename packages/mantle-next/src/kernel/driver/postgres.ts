/** Bun.SQL's PostgreSQL shape (`Postgres`); node-postgres reaches it through an adapter (tests/apps/pg-port.ts). */
import type { Bound } from "../binds.js";
import { ContractError, type Postgres, type PostgresResult } from "../contracts.js";

export const read = async (db: Pick<Postgres, "unsafe">, sql: string, binds: readonly unknown[]): Promise<PostgresResult> => db.unsafe(sql, binds as unknown[]);
export async function run(db: Pick<Postgres, "unsafe">, sql: string, binds: readonly unknown[]): Promise<{ rows: PostgresResult; changes: number }> {
  const rows = await db.unsafe(sql, binds as unknown[]);
  return { rows, changes: Number(rows.count ?? 0) };
}

/**
 * The error to throw when a PostgreSQL write fails where it may already have committed (autocommit, or COMMIT).
 * A server ErrorResponse (SQLSTATE + severity) outside connection/resource classes rolled back; anything else, such as a
 * lost socket, is OUTCOME_UNKNOWN. SQLSTATE is `errno` on Bun.SQL and `code` on node-postgres and postgres.js.
 */
export function postgresOutcome(error: unknown, path: string): unknown {
  const value = error as { errno?: unknown; code?: unknown; severity?: unknown } | null;
  const state = typeof value?.errno === "string" ? value.errno : value?.code;
  if (typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) && typeof value?.severity === "string" && !/^(08|28|53|57|58|XX)/.test(state)) return error;
  return new ContractError("OUTCOME_UNKNOWN", "The write outcome is unknown; reconcile before retrying.", path, { cause: error });
}

/**
 * One statement is atomic on its own (a row statement touches at most one row, so a failed count check changes nothing)
 * and runs in autocommit. Several run in `begin(serializable)`: a failure before the callback returns was rolled back;
 * only a failed COMMIT can leave the outcome unknown.
 */
export async function procedure(db: Postgres, steps: readonly Bound[], path: string): Promise<unknown[][]> {
  const execute = async (handle: Pick<Postgres, "unsafe">) => {
    const results: unknown[][] = [];
    for (const s of steps) {
      const { rows, changes } = await run(handle, s.sql, s.binds);
      if (s.row && changes !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", path);
      results.push(rows);
    }
    return results;
  };
  if (steps.length === 1) {
    try { return await execute(db); } catch (error) { throw error instanceof ContractError ? error : postgresOutcome(error, path); }
  }
  let committing = false;
  try { return await db.begin("isolation level serializable", async tx => { const rows = await execute(tx); committing = true; return rows; }); } catch (error) {
    throw error instanceof ContractError || !committing ? error : postgresOutcome(error, path);
  }
}
