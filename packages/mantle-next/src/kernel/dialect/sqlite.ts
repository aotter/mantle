/** SQLite and Cloudflare D1: `?n` placeholders, time as microseconds and dates as days since the epoch. */
import { encodeDate, encodeTimestamptz } from "../scalars.js";
export { ident, escapeLike, likeEscape, json } from "./common.js";

export const param = (n: number): string => `?${n}`;
export const like = (_insensitive: boolean): string => "LIKE"; // SQLite's LIKE already ignores ASCII case
/** A write that broke a UNIQUE index or the id's UNIQUE (bun:sqlite and D1 word it the same). */
export const unique = (error: unknown): boolean => /UNIQUE constraint failed/.test(String((error as Error)?.message));
// floor, not SQLite's truncating `/` and `%`: a time before 1970 is a negative number of microseconds
export const wireTimestamp = <T>(v: T): (string | T)[] => ["strftime('%Y-%m-%dT%H:%M:%S', ((", v, ") - ((", v, ") % 1000000 + 1000000) % 1000000) / 1000000, 'unixepoch') || '.' || substr('00000' || (((", v, ") % 1000000 + 1000000) % 1000000), -6) || 'Z'"];
export const wireDate = <T>(v: T): (string | T)[] => ["date((", v, ") * 86400, 'unixepoch')"];
export const now = (ms: number): number => ms * 1000;
export const cutoff = (ms: number, seconds: number): number => ms * 1000 - seconds * 1_000_000;
export const timestamp = encodeTimestamptz;
export const date = encodeDate;
export const bool = (v: boolean): number => Number(v);
/** Booleans, dates, JSON and UUIDs are stored as native column types (SQLite keeps 0/1 and text). */
export const nativeTypes = false;
export const cast = (placeholder: string, _type: string): string => placeholder;
