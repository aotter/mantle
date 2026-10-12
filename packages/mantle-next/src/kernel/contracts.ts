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

/** One result row. */
export type Row = Record<string, unknown>;
/** What every generated Procedure returns: the rows of each statement, in order. */
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
 * transaction handle suits Views and single-statement Procedures; multi-statement Procedures call `begin` themselves. Other drivers adapt to it (see README). `begin` must run every statement of `fn` on one connection and
 * COMMIT only after `fn` resolves.
 */
export interface Postgres {
  unsafe(text: string, values: any[]): PromiseLike<PostgresResult>;
  begin(options: string, fn: (tx: Postgres) => Promise<Row[][]>): PromiseLike<Row[][]>;
}
/** What a read or a single statement needs: a transaction handle suits it too. */
export type Unsafe = Pick<Postgres, "unsafe">;
