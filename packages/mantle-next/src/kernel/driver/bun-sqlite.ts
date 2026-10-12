/** `bun:sqlite`: sync queries; interactive transactions queue all work on the same Database. */
import type { Bound } from "../binds.js";
import { conflict, type Row } from "../contracts.js";
import { unique } from "../dialect/sqlite.js";
import { context, guard } from "./transaction-context.js";

export interface Handle {
  query(sql: string): {
    readonly columnNames: readonly string[];
    all(...values: any[]): any[];
    run(...values: any[]): { readonly changes: number | bigint };
  };
  exec(sql: string): unknown;
  transaction(fn: (db: any) => any): (db: any) => any;
}

const transactions = new WeakSet<Handle>();
const queues = new WeakMap<Handle, Promise<void>>();
/** Only queued transactions make otherwise synchronous statements wait; a rejection cannot poison the queue. */
function enqueue<T>(db: Handle, fn: () => T | PromiseLike<T>): Promise<T> {
  const result = (queues.get(db) ?? Promise.resolve()).then(fn);
  const tail = result.then(() => {}, () => {});
  queues.set(db, tail);
  void tail.then(() => { if (queues.get(db) === tail) queues.delete(db); });
  return result;
}
const available = <T>(db: Handle, fn: () => T): T | Promise<T> => { guard(db); return queues.has(db) ? enqueue(db, fn) : fn(); };
export const read = (db: Handle, sql: string, binds: unknown[]): any[] | Promise<any[]> => available(db, () => db.query(sql).all(...binds));
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
  return available(db, () => transactions.has(db) || steps.length === 1 ? execute(db) : db.transaction(execute)(db));
}

export async function transaction<T>(db: Handle, fn: (tx: Handle) => Promise<T>): Promise<T> {
  guard(db);
  if (transactions.has(db)) throw new Error("Nested transactions are not supported.");
  return enqueue(db, async () => {
    db.exec("BEGIN IMMEDIATE");
    let active = true;
    const tx: Handle = { query: sql => {
      if (!active) throw new Error("Transaction has ended.");
      return db.query(sql);
    }, exec: db.exec.bind(db), transaction: db.transaction.bind(db) };
    transactions.add(tx);
    const state: { outer?: Handle } = { outer: db };
    try { const result = await context.run(state, () => fn(tx)); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { active = false; state.outer = undefined; }
  });
}
