/** PostgreSQL: `$n` placeholders, time as timestamptz (ISO text keeps every microsecond). */
import { isoDate, isoTimestamptz } from "../scalars.js";
import { searchLike } from "../search.js";
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
// ponytail: preserve Core's ILIKE scan; add pg_trgm only when measured search latency needs it.
export const search = (_table: string, fields: readonly string[], alias: string, query: string): string => searchLike(fields.map(field => `${alias}.${ident(field)}`), query, "ILIKE");
export const dialect: Dialect = { param, ident, escapeLike, likeEscape, like, search, wireTimestamp, wireDate, now, cutoff, timestamp, date, cast };
