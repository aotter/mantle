/** Keyset paging for a generated View boundary: Core printed the first and next page SQL; this binds, checks the cursor and trims. */
import { ContractError, type Caller } from "./contracts.js";
import { binds, type Recipe, type Values } from "./binds.js";
import { decodeCursor, encodeCursor } from "./store.js";

/** First and next page SQL; `extra` lists, per trailing placeholder, the cursor key it binds (-1: the limit + 1). */
export interface Pages { readonly binds: readonly Recipe[]; readonly first: { readonly sql: string; readonly extra: readonly number[] }; readonly next: { readonly sql: string; readonly extra: readonly number[] } }
/** The order column's cursor check: `int` is int8/integer, `numeric` a NUMERIC with scale, `date`/`timestamp` strings converted by the dialect. */
export type CursorKind = "bool" | "int4" | "int" | "numeric" | "float" | "text" | "date" | "timestamp";
export interface Paged<Database> {
  readonly path: string;
  /** The View's LIMIT, else 500. */
  readonly cap: number;
  readonly sqlite: boolean;
  readonly cursor: CursorKind;
  /** Order keys: the column and id (2), or id only (1). */
  readonly keys: 1 | 2;
  readonly values: Values;
  /** The driver's `read`. */
  readonly read: (db: Database, sql: string, binds: unknown[]) => PromiseLike<any[]> | any[];
  readonly caller: Pages;
  /** System callers' page, when the View's caller page applies row policy. */
  readonly trusted?: Pages;
  readonly auth?: (caller: Caller) => void;
}
type Options = { limit?: number; cursor?: string };

function valid(kind: CursorKind, sqlite: boolean, key: unknown): boolean {
  switch (kind) {
    case "bool": return sqlite ? key === 0 || key === 1 : typeof key === "boolean";
    case "int4": case "int": {
      const [min, max] = kind === "int4" ? [-2147483648n, 2147483647n] : [-9223372036854775808n, 9223372036854775807n];
      return Number.isSafeInteger(key) && (kind !== "int4" || (key as number) >= -2147483648 && (key as number) <= 2147483647) || !sqlite && typeof key === "string" && /^-?\d+$/.test(key) && BigInt(key) >= min && BigInt(key) <= max;
    }
    case "numeric": return sqlite ? Number.isSafeInteger(key) : typeof key === "string" && /^-?\d+(?:\.\d+)?$/.test(key) && Number.isFinite(Number(key));
    case "float": return typeof key === "number" && Number.isFinite(key);
    default: return typeof key === "string";
  }
}

/** A View's paged boundary: `options.limit` defaults to min(50, cap) and is capped at cap and 500. */
export function paged<Database, Input, Row>(spec: Paged<Database>): (db: Database, caller: Caller, input: Input, options?: Options) => Promise<{ rows: Row[]; nextCursor?: string }> {
  const { path, cap } = spec;
  return async (db, caller, input, options = {}) => {
    spec.auth?.(caller);
    const requested = options.limit ?? Math.min(50, cap);
    if (!Number.isInteger(requested) || requested < 1) throw new ContractError("INPUT_VALIDATION_FAILED", "limit must be a positive integer.", path + "/limit");
    const limit = Math.min(requested, cap, 500);
    const m = caller.kind === "system" && spec.trusted ? spec.trusted : spec.caller;
    const values = binds(spec.values, m.binds, caller, input as Readonly<Record<string, unknown>>);
    const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor, path + "/cursor", path);
    if (cursor && !valid(spec.cursor, spec.sqlite, cursor[0])) throw new ContractError("INPUT_VALIDATION_FAILED", "Cursor key has the wrong column type.", path + "/cursor");
    let cursorValue = cursor?.[0];
    if (cursor && (spec.cursor === "date" || spec.cursor === "timestamp")) try { cursorValue = spec.values[spec.cursor]!(cursor[0] as string); } catch { throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed temporal cursor.", path + "/cursor"); }
    const keys = cursor && (spec.keys === 1 ? [cursor[1]] : [cursorValue, cursor[1]]);
    const sql = cursor ? m.next : m.first;
    const rows: Record<string, unknown>[] = await spec.read(db, sql.sql, [...values, ...sql.extra.map(i => i < 0 ? limit + 1 : keys![i])]);
    const last = rows[limit - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last._k0, last[`_k${spec.keys - 1}`], path) : undefined;
    if (rows.length > limit) rows.length = limit;
    for (const row of rows) for (let i = 0; i < spec.keys; i++) delete row[`_k${i}`];
    return { rows: rows as Row[], ...(nextCursor === undefined ? {} : { nextCursor }) };
  };
}

/** A View without ORDER BY (one row or an aggregate) is a single page. */
export function single<Database, Input, Row>(query: (db: Database, caller: Caller, input: Input) => Promise<Row[]>, path: string): (db: Database, caller: Caller, input: Input, options?: Options) => Promise<{ rows: Row[] }> {
  return async (db, caller, input, options = {}) => {
    if (options.cursor !== undefined || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new ContractError("INPUT_VALIDATION_FAILED", "This single-page View needs a positive limit and no cursor.", path);
    return { rows: await query(db, caller, input) };
  };
}
