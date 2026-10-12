/** Host-only TTL maintenance; the selected candidates and delete share one native transaction. */
import { ContractError, type Caller, type Row } from "./contracts.js";
import { binds, type Values } from "./binds.js";

export interface SweepInput { readonly limit?: number; readonly cursor?: string; readonly delete?: boolean }
export interface SweepResult { readonly scanned: number; readonly removed: number; readonly nextCursor?: string }
export async function sweep<DB>(db: DB, caller: Caller, input: SweepInput, path: string, seconds: number, sql: readonly [string, string], d: Values, execute: (db: DB, steps: {sql: string; binds: unknown[]}[], path: string) => Promise<Row[][]>): Promise<SweepResult> {
  if (caller.kind !== "system" || typeof caller.reason !== "string" || !caller.reason.trim()) throw new ContractError("AUTH_DENIED", "TTL maintenance requires a host system caller with a reason.", path);
  const limit = input.limit ?? 500;
  const invalid = (): never => { throw new ContractError("INPUT_VALIDATION_FAILED", "Sweep limit must be 1..500, delete boolean, and cursor belong to this sweep.", path); };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || input.delete !== undefined && typeof input.delete !== "boolean") invalid();
  let after = 0;
  if (input.cursor !== undefined) {
    try { const value = JSON.parse(decodeURIComponent(input.cursor)); if (!Array.isArray(value) || value.length !== 2 || value[0] !== path || !Number.isSafeInteger(value[1]) || value[1] < 1) invalid(); after = value[1]; } catch { invalid(); }
  }
  const values = [...binds(d, [{k: "cutoff", seconds}], caller), after, limit];
  const [selected, deleted] = await execute(db, (input.delete === false ? [sql[0]] : sql).map(sql => ({sql, binds: values})), path);
  const last = Number(selected!.at(-1)?._rid);
  return {scanned: selected!.length, removed: deleted?.length ?? 0, ...(selected!.length === limit ? {nextCursor: encodeURIComponent(JSON.stringify([path, last]))} : {})};
}
