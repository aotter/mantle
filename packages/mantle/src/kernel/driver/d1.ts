/** Cloudflare D1: no interactive transactions, so a Procedure is one `batch` whose row checks go through `_mantle_assert`. */
import type { Bound } from "../binds.js";
import { checkConflict, conflict, lockConflict, type Row } from "../contracts.js";
import { unique } from "../dialect/sqlite.js";
export { definitive } from "../dialect/sqlite.js";

interface Statement { bind(...values: any[]): Statement; all(): Promise<{ results: any[]; meta: { changes: number } }> }
export interface Reader { prepare(sql: string): Statement }
export interface Handle extends Reader { batch(statements: any[]): Promise<{ results: any[] }[]> }

export const read = async (db: Reader, sql: string, binds: unknown[]): Promise<any[]> => (await db.prepare(sql).bind(...binds).all()).results;
/** The assert table's trigger aborts the whole batch with `CONFLICT op=<k>` when statement k did not change exactly one row. */
export async function procedure(db: Handle, steps: readonly Bound[], path: string): Promise<Row[][]> {
  const batch: Statement[] = [], at: number[] = [];
  steps.forEach((s, i) => {
    at.push(batch.length);
    batch.push(db.prepare(s.sql).bind(...s.binds));
    if (s.row) batch.push(db.prepare(`INSERT INTO _mantle_assert (op,ok) SELECT ${i}, changes() = 1`));
  });
  let out;
  try { out = await db.batch(batch); } catch (error) {
    const op = /CONFLICT op=(\d+)/.exec(String((error as Error)?.message)), probe = op ? steps[Number(op[1])]?.lock : undefined;
    // the batch rolled back, so a lock probe reads the state before it
    if (probe) throw lockConflict(path, probe, await read(db, probe.sql, probe.binds));
    throw unique(error) ? conflict(path, true, error) : op ? conflict(path, false, error) : checkConflict(path, error) ?? error;
  }
  return at.map(i => out[i]!.results);
}
