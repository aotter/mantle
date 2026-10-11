/** Cloudflare D1: no interactive transactions, so a Procedure is one `batch` whose row checks go through `_mantle_assert`. */
import type { Bound } from "../binds.js";
import { ContractError } from "../contracts.js";
import { unique } from "../dialect/sqlite.js";

interface Statement { bind(...values: any[]): Statement; all(): Promise<{ results: any[]; meta: { changes?: number } }> }
export interface Reader { prepare(sql: string): Statement }
export interface Handle extends Reader { batch(statements: any[]): Promise<{ results: any[] }[]> }

export const read = async (db: Reader, sql: string, binds: readonly unknown[]): Promise<any[]> => (await db.prepare(sql).bind(...binds).all()).results;
export async function run(db: Reader, sql: string, binds: readonly unknown[]): Promise<{ rows: any[]; changes: number }> {
  const { results, meta } = await db.prepare(sql).bind(...binds).all();
  return { rows: results ?? [], changes: meta?.changes ?? 0 };
}
/** The assert table's trigger aborts the whole batch with `CONFLICT op=<k>` when statement k did not change exactly one row. */
export async function procedure(db: Handle, steps: readonly Bound[], path: string): Promise<unknown[][]> {
  const batch: unknown[] = [], at: number[] = [];
  steps.forEach((s, i) => {
    at.push(batch.length);
    batch.push(db.prepare(s.sql).bind(...s.binds));
    if (s.row) batch.push(db.prepare(`INSERT INTO _mantle_assert (op,ok) SELECT ${i}, changes() = 1`));
  });
  let out;
  try { out = await db.batch(batch as never[]); } catch (error) {
    if (unique(error)) throw new ContractError("CONFLICT", "A unique constraint of the Schema was violated.", path, { cause: error });
    throw /CONFLICT op=\d/.test(String((error as Error)?.message)) ? new ContractError("CONFLICT", "Expected one affected row.", path, { cause: error }) : error;
  }
  return at.map(i => out[i]!.results);
}
