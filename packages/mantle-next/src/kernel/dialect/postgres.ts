/** PostgreSQL: `$n` placeholders, time as timestamptz (ISO text keeps every microsecond). */
import { isoDate, isoTimestamptz } from "../scalars.js";
import { escapeLike, ident, likeEscape, type Dialect } from "./common.js";
export { ident, escapeLike, likeEscape };

export const param = (n: number): string => `$${n}`;
export const like = (insensitive: boolean): string => insensitive ? "ILIKE" : "LIKE";
export const wireTimestamp = <T>(v: T): (string | T)[] => ["to_char((", v, ") AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"];
export const wireDate = <T>(v: T): (string | T)[] => ["to_char(", v, ", 'YYYY-MM-DD')"];
export const now = (ms: number): Date => new Date(ms);
export const cutoff = (ms: number, seconds: number): Date => new Date(ms - seconds * 1000);
export const timestamp = isoTimestamptz;
export const date = isoDate;
export const cast = (placeholder: string, type: string): string => type === "timestamptz" || type === "date" ? `CAST(CAST(${placeholder} AS text) AS ${type})` : type === "json" ? `CAST(CAST(${placeholder} AS text) AS jsonb)` : placeholder;
export const values = { now, cutoff, timestamp, date };
export const dialect: Dialect = { param, ident, escapeLike, likeEscape, like, wireTimestamp, wireDate, ...values, cast };
