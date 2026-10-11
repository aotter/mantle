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
