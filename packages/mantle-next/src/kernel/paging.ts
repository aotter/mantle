/** Keyset paging for a generated View boundary: Core printed the first and next page SQL; this binds, checks the cursor and trims. */
import type { Caller } from "./contracts.js";
import { binds, type Recipe, type Values } from "./binds.js";
import { invalid } from "./surface.js";

/** Shared keyset wire format; a selected View binds its cursor to its operation. */
export const encodeCursor = (value: unknown, id: unknown, operation?: string): string => encodeURIComponent(JSON.stringify(operation === undefined ? [value, id] : [value, id, operation]));
export function decodeCursor(cursor: string, path = "", operation?: string): [unknown, unknown] {
  try {
    const c = JSON.parse(decodeURIComponent(cursor));
    if (Array.isArray(c) && c.length === (operation === undefined ? 2 : 3) && (operation === undefined || typeof c[1] === "string" && (typeof c[0] === "string" || typeof c[0] === "boolean" || typeof c[0] === "number" && Number.isFinite(c[0])) && c[2] === operation)) return [c[0], c[1]];
  } catch {}
  invalid("Malformed or foreign cursor.", path);
}

/** First and next page SQL; `extra` lists, per trailing placeholder, the cursor key it binds (-1: the limit + 1). */
export interface Pages { readonly binds: readonly Recipe[]; readonly first: { readonly sql: string; readonly extra: readonly number[]; readonly matches?: readonly string[] }; readonly next: { readonly sql: string; readonly extra: readonly number[]; readonly matches?: readonly string[] } }
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
type Options = { limit?: number; cursor?: string; match?: Readonly<Record<string, unknown>> };

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

/**
 * A View's paged boundary: `options.limit` defaults to min(50, cap) and is capped at cap and 500. Generated modules
 * call it from their exported function, so importing a View runs no kernel code.
 */
export async function page<Database, Row>(spec: Paged<Database>, db: Database, caller: Caller, input: unknown, options: Options = {}): Promise<{ rows: Row[]; nextCursor?: string }> {
  const { path, cap } = spec, two = spec.keys === 2;
  spec.auth?.(caller);
  const requested = options.limit ?? Math.min(50, cap);
  if (!Number.isInteger(requested) || requested < 1) invalid("limit must be a positive integer.", path + "/limit");
  const limit = Math.min(requested, cap, 500);
  const m = caller.kind === "system" && spec.trusted ? spec.trusted : spec.caller;
  const values = binds(spec.values, m.binds, caller, input as Readonly<Record<string, unknown>>);
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor, path + "/cursor", path);
  if (cursor && !valid(spec.cursor, spec.sqlite, cursor[0])) invalid("Cursor key has the wrong column type.", path + "/cursor");
  let cursorValue = cursor?.[0];
  if (cursor && (spec.cursor === "date" || spec.cursor === "timestamp")) try { cursorValue = spec.values[spec.cursor]!(cursor[0] as string); } catch { invalid("Malformed temporal cursor.", path + "/cursor"); }
  const keys = cursor && (spec.keys === 1 ? [cursor[1]] : [cursorValue, cursor[1]]);
  const sql = cursor ? m.next : m.first;
  const rows: Record<string, unknown>[] = await spec.read(db, sql.sql, [...values, ...sql.extra.map(i => i < 0 ? limit + 1 : keys![i]), ...(sql.matches ?? []).map(key => options.match?.[key] ?? null)]);
  const last = rows[limit - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last._k0, two ? last._k1 : last._k0, path) : undefined;
  if (rows.length > limit) rows.length = limit;
  for (const row of rows) { delete row._k0; if (two) delete row._k1; }
  return { rows: rows as Row[], ...(nextCursor === undefined ? {} : { nextCursor }) };
}

/** A View without ORDER BY (one row or an aggregate) is a single page. */
export async function single<Row>(rows: () => Promise<Row[]>, path: string, options: Options = {}): Promise<{ rows: Row[] }> {
  if (options.cursor !== undefined || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) invalid("This single-page View needs a positive limit and no cursor.", path);
  return { rows: await rows() };
}
