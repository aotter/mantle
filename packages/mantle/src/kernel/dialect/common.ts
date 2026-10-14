/** What SQLite and PostgreSQL spell identically, defined once; each dialect module re-exports it. */

/** A (possibly schema-qualified) name, quoted. */
export const ident = (name: string): string => name.split(".").map(part => `"${part.replaceAll('"', '""')}"`).join(".");
/** A literal piece of text for a LIKE pattern: `\`, `%` and `_` match themselves. Pair with `likeEscape`. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");
export const likeEscape = " ESCAPE '\\'";

/**
 * How one engine spells SQL and stores values, exactly what the Store needs: each dialect module exports it as `dialect` (and its
 * members by name, so a bundle that uses a few carries only those). A generated bundle imports one dialect; nothing branches on it.
 */
export interface Dialect {
  readonly userRefs?: import('../binds.js').Values['userRefs'];
  readonly user?: import('../binds.js').Values['user'];
  readonly isAll?: import('../binds.js').Values['isAll'];
  readonly anyOf?: (column: string, placeholder: string, type: 'string' | 'number') => string;
  readonly scopeInsert?: (scopes: readonly { readonly column: string; readonly field: string; readonly type: 'string' | 'number' }[], caller: import('../contracts.js').Caller, set: object) => object;
  /** The `n`th (1-based) numbered placeholder. */
  param(n: number): string;
  ident(name: string): string;
  escapeLike(value: string): string;
  likeEscape: string;
  /** The LIKE keyword; PostgreSQL's is case-sensitive unless `insensitive`. */
  like(insensitive: boolean): string;
  /** Search declared text fields; the caller separately permits an exact id match. */
  search(table: string, fields: readonly string[], alias: string, query: string): string;
  /** A declared date-time / date in its wire form (ISO UTC with six digits, `YYYY-MM-DD`): text parts interleaved with the operand. */
  wireTimestamp<T>(v: T): (string | T)[];
  wireDate<T>(v: T): (string | T)[];
  /** Bind values: `now()` and a TTL cutoff from epoch milliseconds, declared ISO inputs, and the typed Store inputs. */
  now(ms: number): unknown;
  cutoff(ms: number, seconds: number): unknown;
  timestamp(v: string | Date): unknown;
  date(v: string): unknown;
  /** A placeholder compared with, or written to, a column of this type, so every driver sends the value verbatim (postgres.js would turn text bound to timestamptz or date into a JavaScript Date and lose microseconds). */
  cast(placeholder: string, type: string): string;
}
