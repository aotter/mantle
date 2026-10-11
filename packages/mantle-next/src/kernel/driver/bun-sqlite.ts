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
/** One statement is atomic on its own; several run in a transaction, and a row statement that does not change exactly one row rolls it back. */
export async function procedure(db: Handle, steps: readonly Bound[], path: string): Promise<unknown[][]> {
  const execute = (handle: Handle) => steps.map(s => {
    const statement = handle.query(s.sql);
    // a statement with columns (SELECT, RETURNING) gives rows, and their number is its affected count
    const rows = statement.columnNames.length ? statement.all(...s.binds) : [];
    const changes = statement.columnNames.length ? rows.length : Number(statement.run(...s.binds).changes);
    if (s.row && changes !== 1) throw new ContractError("CONFLICT", "Expected one affected row.", path);
    return rows;
  });
  return steps.length === 1 ? execute(db) : db.transaction(execute)(db);
}
