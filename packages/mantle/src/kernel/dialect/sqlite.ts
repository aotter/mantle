import { ContractError } from "../contracts.js";
/** SQLite and Cloudflare D1: `?n` placeholders, time as microseconds and dates as days since the epoch. */
import { encodeDate, encodeTimestamptz } from "../scalars.js";
import { searchLike } from "../search.js";
import { escapeLike, ident, likeEscape, type Dialect } from "./common.js";
export { ident, escapeLike, likeEscape };

export const param = (n: number): string => `?${n}`;
export const anyOf = (column: string, placeholder: string): string => `${column} IN (SELECT value FROM json_each(${placeholder}))`;
export const like = (): string => "LIKE"; // SQLite's LIKE already ignores ASCII case
/** A write that broke a UNIQUE index or the id's UNIQUE (bun:sqlite and D1 word it the same). */
export const unique = (error: unknown): boolean => /UNIQUE constraint failed/.test(String((error as Error)?.message));
/** Positive rollback evidence only. Plain/network/I/O errors are deliberately uncertain. */
export function definitive(error: unknown): boolean {
  if (error instanceof ContractError) return error.code === "CONFLICT";
  const e = error as {name?:unknown;code?:unknown;errno?:unknown} | null;
  // Bun before 1.4 omits `code` on statement errors; its SQLiteError still carries the native errno.
  const native = typeof e?.code === "string" ? e.code.startsWith("SQLITE_") : e?.name === "SQLiteError";
  return native && typeof e!.errno === "number" && [1,19,20,25].includes(e!.errno & 255);
}
// floor, not SQLite's truncating `/` and `%`: a time before 1970 is a negative number of microseconds
export const wireTimestamp = <T>(v: T): (string | T)[] => ["strftime('%Y-%m-%dT%H:%M:%S', ((", v, ") - ((", v, ") % 1000000 + 1000000) % 1000000) / 1000000, 'unixepoch') || '.' || substr('00000' || (((", v, ") % 1000000 + 1000000) % 1000000), -6) || 'Z'"];
export const wireDate = <T>(v: T): (string | T)[] => ["date((", v, ") * 86400, 'unixepoch')"];
export const now = (ms: number): number => ms * 1000;
export const cutoff = (ms: number, seconds: number): number => ms * 1000 - seconds * 1_000_000;
export const timestamp = encodeTimestamptz;
export const date = encodeDate;
export const cast = (placeholder: string): string => placeholder;
export function search(table: string, fields: readonly string[], alias: string, query: string): string {
  const fts = ident(`_mantle_fts_${table}`);
  const phrase = `'"' || replace(${query}, '"', '""') || '"'`;
  return `CASE WHEN length(${query}) >= 3 THEN ${alias}._rid IN (SELECT rowid FROM ${fts} WHERE ${fts} = ${phrase}) ELSE (${searchLike(fields.map(field => `${alias}.${ident(field)}`), query, "LIKE")}) END`;
}
export const dialect: Dialect = { param, ident, escapeLike, likeEscape, like, search, wireTimestamp, wireDate, now, cutoff, timestamp, date, cast, anyOf };
