/** Caller identity (ADR-0032 decision 8). Mantle never owns the user or the auth; a resolver produces the Caller. */
import type { StaffRole } from "../spec/domain/index.js";

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

/**
 * Resolves the Caller once per request, at the service's entry. `invalid` is answered 401 before any
 * surface runs and is never anonymous; only "no credential presented" is.
 */
export type CallerResolver = (request: Request) => Promise<{ readonly caller: Caller } | { readonly invalid: true; readonly challenge?: string; /** 403 for a valid token that lacks a scope (RFC 6750 insufficient_scope); 401 otherwise. */ readonly status?: 401 | 403 }>;

/** Host code only; no wire produces one. Satisfies no `requires.auth` predicate, bypasses caller scope and nothing else. */
export const systemCaller = (reason: string): Caller => ({ kind: "system", reason });
