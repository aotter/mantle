/** `bun:sqlite`: synchronous; a multi-statement Procedure is one `db.transaction`. */
import type { Bound } from "../binds.js";
import { ContractError } from "../contracts.js";

export interface Handle {
  query(sql: string): {
    readonly columnNames: readonly string[];
    all(...values: any[]): unknown[];
    run(...values: any[]): { readonly changes: number | bigint };
  };
  transaction(fn: (db: any) => any): (db: any) => any;
}

export const read = (db: Handle, sql: string, binds: readonly unknown[]): unknown[] => db.query(sql).all(...binds);
/** A statement that returns columns (SELECT, RETURNING) gives rows, and its affected count is their number. */
export function run(db: Handle, sql: string, binds: readonly unknown[]): { rows: unknown[]; changes: number } {
  const statement = db.query(sql);
  if (statement.columnNames.length) { const rows = statement.all(...binds); return { rows, changes: rows.length }; }
  return { rows: [], changes: Number(statement.run(...binds).changes) };
}
/** One statement is atomic on its own; several run in a transaction, and a statement that must change one row and does not rolls it back. */
export async function procedure(db: Handle, steps: readonly Bound[], path: string): Promise<unknown[][]> {
  const execute = (handle: Handle) => steps.map(s => {
    const { rows, changes } = run(handle, s.sql, s.binds);
    if (s.row && changes !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", path);
    return rows;
  });
  return steps.length === 1 ? execute(db) : db.transaction(execute)(db);
}
