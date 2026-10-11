/** PostgreSQL: `$n` placeholders, time as timestamptz (ISO text keeps every microsecond). */
import { isoDate, isoTimestamptz } from "../scalars.js";
export { ident, escapeLike, likeEscape, json } from "./common.js";

export const param = (n: number): string => `$${n}`;
export const like = (insensitive: boolean): string => insensitive ? "ILIKE" : "LIKE";
/** SQLSTATE of a server error: `errno` on Bun.SQL, `code` on postgres.js. */
export const sqlstate = (error: unknown): unknown => { const e = error as { errno?: unknown; code?: unknown } | null; return typeof e?.errno === "string" ? e.errno : e?.code; };
export const unique = (error: unknown): boolean => sqlstate(error) === "23505";
export const wireTimestamp = <T>(v: T): (string | T)[] => ["to_char((", v, ") AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"];
export const wireDate = <T>(v: T): (string | T)[] => ["to_char(", v, ", 'YYYY-MM-DD')"];
export const now = (ms: number): Date => new Date(ms);
export const cutoff = (ms: number, seconds: number): Date => new Date(ms - seconds * 1000);
export const timestamp = isoTimestamptz;
export const date = isoDate;
export const bool = (v: boolean): boolean => v;
/** Booleans, dates, JSON and UUIDs are stored as native column types (SQLite keeps 0/1 and text). */
export const nativeTypes = true;
export const cast = (placeholder: string, type: string): string => type === "timestamptz" || type === "date" ? `CAST(CAST(${placeholder} AS text) AS ${type})` : type === "json" ? `CAST(CAST(${placeholder} AS text) AS jsonb)` : placeholder;
