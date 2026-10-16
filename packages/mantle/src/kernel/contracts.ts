/** Boundary primitives only. No plan, SQL interpreter or resource ownership. */
import { ContractError } from "./contract-error.js";
export { ContractError } from "./contract-error.js";
import { hasRole, isAdminCaller as isAdmin } from "./caller-identity.js";
export type CredentialKind = "session" | "oauth" | "api-key" | "personal-token";

export interface Gateway { readonly tenant: string }
export interface RequestContext { readonly props?: unknown }
/** Gateway mode or the one execution prop carrying forwarded authority. */
export const forwarded = (ctx?: RequestContext, gateway?: Gateway): boolean => !!(gateway || ctx?.props && Object.hasOwn(ctx.props, "mantle"));
/** Generated gateway metadata is loaded only after a forwarded request. */
export interface AccessTarget {
  readonly targetHash: string;
  readonly opaque: boolean;
  readonly guard?: string;
  readonly variants?: readonly (Pick<AccessTarget, "opaque" | "guard"> & { readonly id: string })[];
}
export interface AccessEvent {
  readonly v: 1;
  readonly requestId: string;
  readonly target: string;
  readonly targetHash: string;
  readonly caller: { readonly kind: string; readonly subject: string; readonly layer: "admin" | "member" };
  readonly outcome: "allow" | "deny" | "error";
  readonly reason?: string;
  readonly field?: string;
  readonly dryRun: boolean;
}
export interface GatewayOptions {
  readonly accessTargets?: () => Promise<Readonly<Record<string, AccessTarget>>>;
  readonly onAccess?: (event: AccessEvent) => void | Promise<void>;
}

type IdentityCaller = {
  /** Application subject key: opaque, stable, unique across issuers. Never an email. */
  readonly subject: string;
  readonly issuer?: string;
  /** Verified real actor during impersonation; retained only by the original identity. */
  readonly impersonatedBy?: string;
  readonly role: string | null;
  /** Informational; only the private identity brand grants the admin layer. */
  readonly admin?: boolean;
  readonly roles?: readonly string[];
  readonly fields?: Readonly<Record<string, import("./user-fields.js").UserValue>>;
  readonly scopes: readonly string[];
  readonly credential: CredentialKind;
  /** Opaque record id or token JTI, never the raw credential. */
  readonly credentialId: string | null;
  readonly clientId: string | null;
  readonly authenticatedAs?: "snapshot" | "fresh";
  readonly requestId?: string;
  readonly target?: string;
  readonly targetHash?: string;
  readonly dryRun?: boolean;
};
export type Caller =
  | { readonly kind: "anonymous" }
  | (IdentityCaller & { readonly kind: "user" })
  | (IdentityCaller & { readonly kind: "host"; readonly authenticatedAs: "snapshot" | "fresh"; readonly requestId: string })
  | { readonly kind: "system"; readonly reason: string };

/** A selected boundary's application authorization target. */
export type Target = { kind: "view" | "procedure" | "schema"; name: string; action?: "read" | "create" | "update" | "delete" };
export type Authorize = (target: Target, caller: Caller) => boolean | Promise<boolean>;

/** Privilege never follows a member role name. Only the original verified identity carries the admin layer. */
export { isAdmin };
/** Both authenticated layers pass ctx.user; the host layer still needs its original brand. */
export const isUser = (caller: Caller): boolean => caller.kind === "user" || isAdmin(caller);
export const hasAdminRole = (caller: Caller, name: string): boolean => isAdmin(caller) && hasRole(caller, name);

/** Only the core transport failures; other codes carry their own status, and unknown codes remain server errors. */
export const statusOf = (code: string): number => ({ __proto__: null,
  INPUT_VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, AUTH_DENIED: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, CONFLICT: 409, OUTCOME_UNKNOWN: 503,
} as Record<string, number | null>)[code] ?? 500;

/** Redact native errors at the selected boundary; the bare query preserves their identity. */
export function wire(error: unknown): { status: number; error: { code: string; message: string; path: string; [field: string]: unknown } } {
  const status = error instanceof ContractError ? error.status ?? statusOf(error.code) : 500;
  if (status !== 500) { const { code, message, path, fields } = error as ContractError; return { status, error: { code, message, path, ...fields } }; }
  return { status, error: { code: "INTERNAL_ERROR", message: "An internal error occurred.", path: "" } };
}

/** One result row. */
export type Row = Record<string, unknown>;
/** Static declared-column conversions, used only by selected transport boundaries. */
export type WireColumns = ReadonlyArray<readonly [field: string, type: "json" | "bool" | "int"]>;
export function wireRows(rows: readonly Row[], fields: WireColumns = []): readonly Row[] {
  if (!fields.length) return rows;
  return rows.map(row => {
    const result = { ...row };
    for (const [key, type] of fields) if (Object.hasOwn(row, key) && row[key] != null) {
      const value = row[key];
      if (type === "json") {
        try { result[key] = JSON.parse(value as string); }
        catch { throw new ContractError("INVALID_STORED_JSON", "Persisted JSON could not be parsed."); }
      } else result[key] = type === "bool" ? value === true || value === 1
        : typeof value === "number" || Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
    }
    return result;
  });
}
/** What a generated SQL Procedure returns: the rows of each statement, in order. */
export type Output = { readonly results: ReadonlyArray<ReadonlyArray<Row>> };
/** Deny unless `allowed`: a user is AUTH_DENIED, anyone else UNAUTHENTICATED. */
export function deny(caller: Caller, allowed: boolean, path: string): void {
  if (!allowed) throw new ContractError("subject" in caller ? "AUTH_DENIED" : "UNAUTHENTICATED", "Authorization predicate not satisfied.", path);
}
/** CONFLICT for a write the database refused: a unique-index clash, or a row statement that did not change exactly one row. */
export const conflict = (path: string, unique: boolean, cause?: unknown): ContractError =>
  new ContractError("CONFLICT", unique ? "A unique constraint of the Schema was violated." : "Expected one affected row.", path, { cause });
/** A Schema `checks` violation (Mantle's SQLite check trigger, or PostgreSQL SQLSTATE 23514) is a CONFLICT naming the check. */
export const checkConflict = (path: string, error: unknown, violated = /MANTLE_CHECK /.test(String((error as Error)?.message))): ContractError | undefined => {
  if (!violated) return undefined;
  const message = String((error as Error)?.message ?? "");
  return new ContractError("CONFLICT", `A check of the Schema failed: ${/MANTLE_CHECK [^\n'"]+/.exec(message)?.[0] ?? message}`, path, { cause: error });
};

/** One result of `unsafe`: the rows (typed by the generated function), plus the affected count. */
export type PostgresResult = any[] & { readonly count: number | null };
/**
 * The PostgreSQL handle bare generated code calls: Bun.SQL's own shape, so Bun passes its `SQL` directly. A Bun
 * transaction handle suits generated queries; the driver marks Store transaction handles to suppress nested `begin`. Other drivers adapt to it (see README). `begin` must run every statement of `fn` on one connection and
 * COMMIT only after `fn` resolves.
 */
export interface Postgres {
  unsafe(text: string, values: any[]): PromiseLike<PostgresResult>;
  /** The transaction handle only needs `unsafe`: postgres.js 3.4.9 types it without `begin`. */
  begin<T>(options: string, fn: (tx: Unsafe) => Promise<T>): PromiseLike<T>;
}
/** What a read or a single statement needs: a transaction handle suits it too. */
export type Unsafe = Pick<Postgres, "unsafe">;

/** A cookie is ambient authority; bearer credentials deliberately supplied by the app are not. */
export function checkOrigin(request: Request, caller: Caller): void {
  if (!("credential" in caller) || caller.credential !== "session" || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const site = request.headers.get("sec-fetch-site"), origin = request.headers.get("origin");
  if ((!site && !origin) || (site && site !== "same-origin" && site !== "none") || (origin && origin !== new URL(request.url).origin))
    throw new ContractError("AUTH_DENIED", "Cross-origin session mutation rejected.", "request:origin");
}

/** A resolver's ContractError (e.g. UNAUTHENTICATED for an expired token) keeps its status; anything else is an application failure. */
export async function surfaceCaller<Env>(request: Request, env: Env, resolve: (request: Request, env: Env, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>, readOnly = false): Promise<Caller> {
  try { return await resolve(request, env, { readOnly }); } catch (cause) { if (cause instanceof ContractError) throw cause; throw new Error("Caller resolution failed.", {cause}); }
}
/** The client sees the redacted wire form; the log gets the surface (a route or tool, never headers) and the original message, stack and cause. */
export function surfaceError(error: unknown, where = "surface"): ReturnType<typeof wire> {
  const result = wire(error);
  if (result.status === 500) console.error(`[mantle ${where}] unhandled failure`, error);
  return result;
}
export function surfaceFailure(error: unknown, challenge?: string, where?: string): Response {
  const result = surfaceError(error, where);
  return Response.json({error: result.error}, {status: result.status, headers: {"cache-control": "private, no-store", ...(challenge && [401,403].includes(result.status) && result.error.path !== "request:origin" ? {"www-authenticate": challenge} : {})}});
}
