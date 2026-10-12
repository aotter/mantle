/** `bun:sqlite`: synchronous; a multi-statement Procedure is one `db.transaction`. */
import type { Bound } from "../binds.js";
import { conflict, type Row } from "../contracts.js";
import { unique } from "../dialect/sqlite.js";

export interface Handle {
  query(sql: string): {
    readonly columnNames: readonly string[];
    all(...values: any[]): any[];
    run(...values: any[]): { readonly changes: number | bigint };
  };
  transaction(fn: (db: any) => any): (db: any) => any;
}

export const read = (db: Handle, sql: string, binds: unknown[]): any[] => db.query(sql).all(...binds);
/** One statement is atomic on its own; several run in a transaction, and a row statement that does not change exactly one row rolls it back. A unique-index clash is CONFLICT. */
export async function procedure(db: Handle, steps: readonly Bound[], path: string): Promise<Row[][]> {
  const execute = (handle: Handle) => steps.map(s => {
    const statement = handle.query(s.sql);
    // a statement with columns (SELECT, RETURNING) gives rows, and their number is its affected count
    let rows: Row[] = [], changes: number;
    try {
      rows = statement.columnNames.length ? statement.all(...s.binds) : [];
      changes = statement.columnNames.length ? rows.length : Number(statement.run(...s.binds).changes);
    } catch (error) { throw unique(error) ? conflict(path, true, error) : error; }
    if (s.row && changes !== 1) throw conflict(path, false);
    return rows;
  });
  return steps.length === 1 ? execute(db) : db.transaction(execute)(db);
}
