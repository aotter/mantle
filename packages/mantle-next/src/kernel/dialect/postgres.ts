/** PostgreSQL: `$n` placeholders, explicit NULLS placement, time as timestamptz (ISO text keeps every microsecond). */
import { isoDate, isoTimestamptz } from "../scalars.js";
export { ident, escapeLike, likeEscape, json } from "./common.js";

export const param = (n: number): string => `$${n}`;
export const like = (insensitive: boolean): string => insensitive ? "ILIKE" : "LIKE";
export const nulls = (direction: "asc" | "desc"): string => direction === "asc" ? " NULLS FIRST" : " NULLS LAST";
export const wireTimestamp = <T>(v: T): (string | T)[] => ["to_char((", v, ") AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"];
export const wireDate = <T>(v: T): (string | T)[] => ["to_char(", v, ", 'YYYY-MM-DD')"];
export const now = (ms: number): Date => new Date(ms);
export const cutoff = (ms: number, seconds: number): Date => new Date(ms - seconds * 1000);
export const timestamp = isoTimestamptz;
export const date = isoDate;
export const bool = (v: boolean): boolean => v;
/** Booleans, dates, JSON and UUIDs are stored as native column types (SQLite keeps 0/1 and text). */
export const nativeTypes = true;
