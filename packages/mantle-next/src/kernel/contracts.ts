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

/** Only transport failures this package raises; unknown codes remain server errors. */
export function statusOf(code: string): number {
  switch (code) {
    case "INPUT_VALIDATION_FAILED": return 400;
    case "UNAUTHENTICATED": return 401;
    case "AUTH_DENIED": return 403;
    case "NOT_FOUND": return 404;
    case "METHOD_NOT_ALLOWED": return 405;
    case "CONFLICT": return 409;
    case "OUTCOME_UNKNOWN": return 503;
    default: return 500;
  }
}

/** Redact native errors at the selected boundary; the bare query preserves their identity. */
export function wire(error: unknown) {
  return error instanceof ContractError && statusOf(error.code) !== 500
    ? { status: statusOf(error.code), error: { code: error.code, message: error.message, path: error.path } }
    : { status: 500, error: { code: "INTERNAL_ERROR", message: "An internal error occurred.", path: "" } };
}

/** One result row. */
export type Row = Record<string, unknown>;
/** What a generated SQL Procedure returns: the rows of each statement, in order. */
export type Output = { readonly results: ReadonlyArray<ReadonlyArray<Row>> };
/** Deny unless `allowed`: a user is AUTH_DENIED, anyone else UNAUTHENTICATED. */
export function deny(caller: Caller, allowed: boolean, path: string): void {
  if (!allowed) throw new ContractError(caller.kind === "user" ? "AUTH_DENIED" : "UNAUTHENTICATED", "Authorization predicate not satisfied.", path);
}
/** CONFLICT for a write the database refused: a unique-index clash, or a row statement that did not change exactly one row. */
export const conflict = (path: string, unique: boolean, cause?: unknown): ContractError =>
  new ContractError("CONFLICT", unique ? "A unique constraint of the Schema was violated." : "Expected one affected row.", path, { cause });

/** One result of `unsafe`: the rows (typed by the generated function), plus the affected count. */
export type PostgresResult = any[] & { readonly count: number | null };
/**
 * The PostgreSQL handle bare generated code calls: Bun.SQL's own shape, so Bun passes its `SQL` directly. A Bun
 * transaction handle suits generated queries; the driver marks Store transaction handles to suppress nested `begin`. Other drivers adapt to it (see README). `begin` must run every statement of `fn` on one connection and
 * COMMIT only after `fn` resolves.
 */
export interface Postgres {
  unsafe(text: string, values: any[]): PromiseLike<PostgresResult>;
  begin<T>(options: string, fn: (tx: Postgres) => Promise<T>): PromiseLike<T>;
}
/** What a read or a single statement needs: a transaction handle suits it too. */
export type Unsafe = Pick<Postgres, "unsafe">;

/** A cookie is ambient authority; bearer credentials deliberately supplied by the app are not. */
export function checkOrigin(request: Request, caller: Caller): void {
  if (caller.kind !== "user" || caller.credential !== "session" || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const site = request.headers.get("sec-fetch-site"), origin = request.headers.get("origin");
  if ((!site && !origin) || (site && site !== "same-origin" && site !== "none") || (origin && origin !== new URL(request.url).origin))
    throw new ContractError("AUTH_DENIED", "Cross-origin session mutation rejected.", "request:origin");
}

/** A resolver's ContractError (e.g. UNAUTHENTICATED for an expired token) keeps its status; anything else is an application failure. */
export async function surfaceCaller<Env>(request: Request, env: Env, resolve: (request: Request, env: Env) => Caller | Promise<Caller>): Promise<Caller> {
  try { return await resolve(request, env); } catch (cause) { if (cause instanceof ContractError) throw cause; throw new Error("Caller resolution failed.", {cause}); }
}
/** Keep native causes in server logs; transport users receive only the shared redacted error. */
export function surfaceError(error: unknown): ReturnType<typeof wire> {
  const result = wire(error);
  if (result.status === 500) console.error("[mantle surface] unhandled failure", error);
  return result;
}
export function surfaceFailure(error: unknown, challenge?: string): Response {
  const result = surfaceError(error);
  return Response.json({error: result.error}, {status: result.status, headers: {"cache-control": "private, no-store", ...(challenge && [401,403].includes(result.status) && result.error.path !== "request:origin" ? {"www-authenticate": challenge} : {})}});
}
