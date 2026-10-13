/** Boundary primitives only. No plan, SQL interpreter or resource ownership. */
export type CredentialKind = "session" | "oauth" | "api-key" | "personal-token";

export type Caller =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "user";
      /** Application subject key: opaque, stable, unique across issuers. Never an email. */
      readonly subject: string;
      /** Informational. */
      readonly issuer?: string;
      readonly role: string | null;
      /** Privileged layer, classified from Better Auth admin plugin configuration. */
      readonly admin?: boolean;
      readonly scopes: readonly string[];
      readonly credential: CredentialKind;
      /** Opaque record id or token JTI, never the raw credential. */
      readonly credentialId: string | null;
      readonly clientId: string | null;
    }
  | { readonly kind: "system"; readonly reason: string };


/** Privilege never follows a member role name. Application-owned callers set the layer explicitly. */
export const isAdmin = (caller: Caller): caller is Extract<Caller, { kind: "user" }> & { readonly admin: true } => caller.kind === "user" && caller.admin === true;
export const hasAdminRole = (caller: Caller, name: string): boolean => isAdmin(caller) && (caller.role ?? "").split(",").includes(name);

export class ContractError extends Error {
  /** HTTP status for codes outside the core set `statusOf` maps. */
  declare readonly status?: number;
  /** Extra wire fields, after `code`, `message` and `path`. */
  declare readonly fields?: Record<string, unknown>;
  constructor(readonly code: string, message: string, readonly path = "", options?: ErrorOptions & { status?: number; fields?: Record<string, unknown> }) {
    super(message, options);
    this.name = "ContractError";
    if (options?.status) this.status = options.status;
    if (options?.fields) this.fields = options.fields;
  }
}

/** Only the core transport failures; other codes carry their own status, and unknown codes remain server errors. */
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
