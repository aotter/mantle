/** What SQLite and PostgreSQL spell identically, defined once; each dialect module re-exports it. */

/** A (possibly schema-qualified) name, quoted. */
export const ident = (name: string): string => name.split(".").map(part => `"${part.replaceAll('"', '""')}"`).join(".");
/** A literal piece of text for a LIKE pattern: `\`, `%` and `_` match themselves. Pair with `likeEscape`. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");
export const likeEscape = " ESCAPE '\\'";
/** JSON input is text on every target (README: Bun.SQL would encode a string bound to jsonb a second time). */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * How one engine spells SQL and stores values. A generated bundle imports exactly one of `dialect/sqlite` and
 * `dialect/postgres`; nothing branches on it at runtime.
 */
export interface Dialect {
  /** The `n`th (1-based) numbered placeholder. */
  param(n: number): string;
  ident(name: string): string;
  escapeLike(value: string): string;
  likeEscape: string;
  /** The LIKE keyword; PostgreSQL's is case-sensitive unless `insensitive`. */
  like(insensitive: boolean): string;
  /** NULL placement that makes NULL the smallest value in either direction, as SQLite orders (PostgreSQL's default is the opposite). */
  nulls(direction: "asc" | "desc"): string;
  /** A declared date-time / date in its wire form (ISO UTC with six digits, `YYYY-MM-DD`): text parts interleaved with the operand. */
  wireTimestamp<T>(v: T): (string | T)[];
  wireDate<T>(v: T): (string | T)[];
  /** Bind values: `now()` and a TTL cutoff from epoch milliseconds, declared ISO inputs, and the typed Store inputs. */
  now(ms: number): unknown;
  cutoff(ms: number, seconds: number): unknown;
  timestamp(v: string | Date): unknown;
  date(v: string): unknown;
  bool(v: boolean): unknown;
  json(v: unknown): string;
  /** A placeholder compared with, or written to, a column of this type, so every driver sends the value verbatim (postgres.js would turn text bound to timestamptz or date into a JavaScript Date and lose microseconds). */
  cast(placeholder: string, type: string): string;
  readonly nativeTypes: boolean;
}
