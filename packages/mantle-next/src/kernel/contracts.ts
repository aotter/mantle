/** Boundary primitives only. No plan, SQL interpreter or resource ownership. */
type StaffRole = "owner" | "editor" | "contributor";
export type CredentialKind = "session" | "oauth" | "api-key" | "personal-token";

export type Caller =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "user";
      /** Application subject key: opaque, stable, unique across issuers. Never an email. */
      readonly subject: string;
      /** Informational. */
      readonly issuer?: string;
      readonly role: StaffRole | null;
      readonly scopes: readonly string[];
      readonly credential: CredentialKind;
      /** Opaque record id or token JTI, never the raw credential. */
      readonly credentialId: string | null;
      readonly clientId: string | null;
    }
  | { readonly kind: "system"; readonly reason: string };


export class ContractError extends Error {
  constructor(readonly code: string, message: string, readonly path = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "ContractError";
  }
}

/**
 * Declared date-time and date inputs are ISO on every target (the handbook's wire form). A timestamp needs an explicit
 * Z or offset; a day that does not exist (2026-02-30) is refused rather than rolled over. SQLite stores microseconds
 * and days; PostgreSQL receives the canonical text, so it keeps every microsecond.
 */
export function encodeTimestamptz(v: string | Date): number {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new ContractError("SQL_TYPE", "Invalid Date is not a timestamp");
    return v.getTime() * 1000;
  }
  // hours 00-23: Date.parse would roll T24:00 over to the next day
  const m = /^(\d{4}-\d\d-\d\d)[T ]((?:[01]\d|2[0-3]):\d\d(?::\d\d)?)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(String(v).trim());
  if (!m) throw new ContractError("SQL_TYPE", `'${v}' is not a timestamp with an explicit offset`);
  const [, day, time, fraction, offset] = m as unknown as string[];
  const zone = offset === "Z" ? "Z" : offset!.length === 3 ? `${offset}:00` : offset!.includes(":") ? offset! : `${offset!.slice(0, 3)}:${offset!.slice(3)}`;
  const secs = Date.parse(`${day}T${time!.length === 5 ? time + ":00" : time}${zone}`);
  encodeDate(day!);
  const micros = secs * 1000 + Number((fraction ?? "").padEnd(6, "0"));
  if (Number.isNaN(secs) || !Number.isSafeInteger(micros)) throw new ContractError("SQL_TYPE", `'${v}' is not a valid timestamp`);
  return micros;
}
/** A date is the string a calendar shows; a Date instant has no single calendar day, so it is not accepted. */
export function encodeDate(v: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(v));
  if (!m) throw new ContractError("SQL_TYPE", `'${v}' is not a date`);
  const [, y, mo, d] = m as unknown as string[];
  const dt = new Date(0);
  dt.setUTCFullYear(+y!, +mo! - 1, +d!); // Date.UTC would read years 0 to 99 as 1900 to 1999
  if (dt.getUTCDate() !== +d! || dt.getUTCMonth() !== +mo! - 1) throw new ContractError("SQL_TYPE", `'${v}' is not a valid date`);
  return dt.getTime() / 86_400_000;
}
export function isoTimestamptz(v: string | Date): string {
  const us = encodeTimestamptz(v), ms = Math.floor(us / 1000);
  return new Date(ms).toISOString().replace("Z", String(us - ms * 1000).padStart(3, "0") + "Z");
}
export const isoDate = (v: string): string => new Date(encodeDate(v) * 86_400_000).toISOString().slice(0, 10);

/**
 * For the application boundary: bare queries rethrow native errors, which must not reach HTTP users as they are.
 * Classifies a native failure without interpreting SQL or leaking engine messages.
 */
export function databaseError(error: unknown, operation: "read" | "write", path: string, dialect: "sqlite" | "postgres"): ContractError {
  if (error instanceof ContractError) return error;
  const value = (error ?? {}) as { code?: unknown; errno?: unknown; errcode?: unknown; name?: string; message?: string };
  const message = error instanceof Error ? error.message : String(error);
  let code = operation === "write" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE";
  if (dialect === "postgres") {
    // SQLSTATE is `errno` on Bun.SQL (whose `code` is ERR_POSTGRES_SERVER_ERROR) and `code` on node-postgres
    const raw = typeof value.errno === "string" ? value.errno : value.code;
    const state = typeof raw === "string" && /^[0-9A-Z]{5}$/.test(raw) ? raw : undefined;
    if (state === "23505" || state === "MX409") code = "CONFLICT";
    else if (state && /^(22|23|42)/.test(state)) code = "INPUT_VALIDATION_FAILED";
    else if (state && /^(08|28|53|57|58|XX)/.test(state)) code = operation === "write" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE";
    else if (state === "40001" || state === "40P01") code = "RESOURCE_UNAVAILABLE";
    else if (state) code = "INPUT_VALIDATION_FAILED";
  } else {
    const primary = typeof value.errcode === "number" ? value.errcode & 255 : value.name === "SQLiteError" && typeof value.errno === "number" ? value.errno & 255 : undefined;
    const text = message + " " + String(value.code ?? "");
    if (/CONFLICT op=\d+|UNIQUE constraint failed/.test(message)) code = "CONFLICT";
    else if (!/SQLITE_(BUSY|LOCKED|NOMEM|IOERR|FULL|INTERRUPT)/.test(text) && !(primary !== undefined && [5, 6, 7, 9, 10, 13].includes(primary)) && (/SQLITE_[A-Z_]+/.test(text) || primary !== undefined)) code = "INPUT_VALIDATION_FAILED";
  }
  return new ContractError(code, code === "CONFLICT" ? "The write conflicted with database state." : code === "OUTCOME_UNKNOWN" ? "The write outcome is unknown; reconcile before retrying." : "The database operation failed.", path, { cause: error });
}

/** One result of `unsafe`: the rows (typed by the generated function), plus the affected count. */
export type PostgresResult = any[] & { readonly count: number | null };
/**
 * The PostgreSQL handle bare generated code calls: Bun.SQL's own shape, so Bun passes its `SQL` directly. A Bun
 * transaction handle suits Views and single-statement Procedures; multi-statement Procedures call `begin` themselves. Other drivers adapt to it (see README). `begin` must run every statement of `fn` on one connection and
 * COMMIT only after `fn` resolves.
 */
export interface Postgres {
  unsafe(text: string, values: unknown[]): PromiseLike<PostgresResult>;
  begin(options: string, fn: (tx: Postgres) => Promise<unknown[][]>): PromiseLike<unknown[][]>;
}

/**
 * The error to throw when a PostgreSQL write fails where it may already have committed (autocommit, or COMMIT).
 * A server ErrorResponse (SQLSTATE + severity) outside connection/resource classes rolled back; anything else, such as a
 * lost socket, is OUTCOME_UNKNOWN. SQLSTATE is `errno` on Bun.SQL and `code` on node-postgres and postgres.js.
 */
export function postgresOutcome(error: unknown, path: string): unknown {
  const value = error as { errno?: unknown; code?: unknown; severity?: unknown } | null;
  const state = typeof value?.errno === "string" ? value.errno : value?.code;
  if (typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) && typeof value?.severity === "string" && !/^(08|28|53|57|58|XX)/.test(state)) return error;
  return new ContractError("OUTCOME_UNKNOWN", "The write outcome is unknown; reconcile before retrying.", path, { cause: error });
}
