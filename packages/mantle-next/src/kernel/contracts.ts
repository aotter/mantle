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

/** For the application boundary: bare queries rethrow native errors, which must not reach HTTP users as they are. */
/** Classify native failures without interpreting SQL or leaking engine messages. */
export function databaseError(error: unknown, operation: "read" | "write", path: string, dialect: "sqlite" | "postgres"): ContractError {
  if (error instanceof ContractError) return error;
  const value = (error ?? {}) as { code?: unknown; errno?: unknown; errcode?: unknown; name?: string; message?: string };
  const message = error instanceof Error ? error.message : String(error);
  let code = operation === "write" ? "OUTCOME_UNKNOWN" : "RESOURCE_UNAVAILABLE";
  if (dialect === "postgres") {
    const state = typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code) ? value.code : undefined;
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
