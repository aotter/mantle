/** Bun.SQL's PostgreSQL shape (`Postgres`); postgres.js satisfies it as it is. */
import type { Bound } from "../binds.js";
import type { TransactionOptions } from "../store.js";
import { conflict, ContractError, type Postgres, type PostgresResult, type Row, type Unsafe } from "../contracts.js";
import { context, guard } from "./transaction-context.js";

const transactions = new WeakSet<Postgres>();
const ISOLATION: readonly string[] = ["serializable", "repeatable read", "read committed", "read uncommitted"];

export const read = (db: Unsafe, sql: string, binds: unknown[]): PromiseLike<PostgresResult> => { guard(db); return db.unsafe(sql, binds); };
export async function run(db: Unsafe, sql: string, binds: unknown[]): Promise<{ rows: any[]; changes: number }> {
  const rows = await read(db, sql, binds);
  return { rows, changes: Number(rows.count ?? 0) };
}

/** SQLSTATE of a server error: `errno` on Bun.SQL, `code` on postgres.js. */
const sqlstate = (error: unknown): unknown => { const e = error as { errno?: unknown; code?: unknown } | null; return typeof e?.errno === "string" ? e.errno : e?.code; };
/**
 * The error to throw when a PostgreSQL write fails where it may already have committed (autocommit, or COMMIT).
 * A server ErrorResponse (SQLSTATE + severity) outside connection/resource classes rolled back; anything else, such as a
 * lost socket, is OUTCOME_UNKNOWN.
 */
/** A structured server ErrorResponse proves rollback; missing evidence is uncertain. */
export function definitive(error: unknown): boolean {
  if (error instanceof ContractError) return error.code === "CONFLICT";
  const state = sqlstate(error);
  return typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) && typeof (error as { severity?: unknown })?.severity === "string" && !/^(08|28|53|57|58|XX)/.test(state);
}
export function postgresOutcome(error: unknown, path: string): unknown {
  if (definitive(error)) return error;
  return new ContractError("OUTCOME_UNKNOWN", "The write outcome is unknown; reconcile before retrying.", path, { cause: error });
}

/**
 * One statement is atomic on its own (a row statement touches at most one row, so a failed count check changes nothing)
 * and runs in autocommit. Several run in `begin(serializable)`: a failure before the callback returns was rolled back;
 * only a failed COMMIT can leave the outcome unknown.
 */
export async function procedure(db: Postgres, steps: readonly Bound[], path: string): Promise<Row[][]> {
  const execute = async (handle: Unsafe) => {
    const results: Row[][] = [];
    for (const s of steps) {
      const { rows, changes } = await run(handle, s.sql, s.binds).catch(error => { throw sqlstate(error) === "23505" ? conflict(path, true, error) : error; });
      if (s.row && changes !== 1) throw conflict(path, false);
      results.push(rows);
    }
    return results;
  };
  if (transactions.has(db)) return execute(db);
  if (steps.length === 1) {
    try { return await execute(db); } catch (error) { throw error instanceof ContractError ? error : postgresOutcome(error, path); }
  }
  return transaction(db, execute, undefined, path);
}

/** Shared BEGIN/COMMIT outcome handling for Procedures and interactive Store transactions. */
export async function transaction<T>(db: Postgres, fn: (tx: Postgres) => Promise<T>, options: TransactionOptions = {}, path = "store/transaction"): Promise<T> {
  guard(db);
  if (transactions.has(db)) throw new Error("Nested transactions are not supported.");
  let committing = false;
  const state: { outer?: Unsafe } = { outer: db };
  try {
    // printed into BEGIN, so only PostgreSQL's own four levels: a handler may pass request input here
    const level = options.isolation ?? "serializable";
    if (!ISOLATION.includes(level)) throw new ContractError("INPUT_VALIDATION_FAILED", `isolation '${level}' is not a PostgreSQL isolation level`, path);
    return await db.begin(`isolation level ${level}`, async handle => {
      let active = true;
      const tx: Postgres = { unsafe: (sql, values) => {
        if (!active) throw new Error("Transaction has ended.");
        return handle.unsafe(sql, values);
      }, begin: async () => { throw new Error("Nested transactions are not supported."); } };
      transactions.add(tx);
      try { const result = await context.run(state, () => fn(tx)); committing = true; return result; }
      finally { active = false; }
    });
  } catch (error) { throw error instanceof ContractError || !committing ? error : postgresOutcome(error, path); }
  finally { state.outer = undefined; }
}
