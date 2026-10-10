/**
 * `CallerResolver` for a Better Auth identity (ADR-0032 decision 8). Precedence: a service's own credential, an OAuth access
 * token (Bearer or DPoP), the cookie session. A presented credential that fails never falls back to a session cookie, and only
 * "no credential presented" is anonymous. The role is read fresh on every request so a revoked staff role cannot linger in a
 * session snapshot.
 */
import { STAFF_ROLES, type StaffRole } from "../spec/domain/index.js";
import type { OAuthAccessTokenVerification } from "./types.js";
import type { Caller, CallerResolver, CredentialKind } from "../core/index.js";
import { rememberSessionUser } from "../core/sessionUser.js";

/** The three things the resolver needs of a Better Auth facade; a custom facade only has to provide these. */
export interface AuthLike {
  getSession(request: Request): Promise<{ session: { id: string }; user: { id: string; email?: string; name?: string; image?: string | null; githubLogin?: string | null; role?: string | null; /** the role came from the same uncached read */ roleCurrent?: true } } | null>;
  getUserRole(userId: string): Promise<string | null>;
  verifyOAuthAccessToken(tokenOrRequest: string | Request, options: { audience: string; scopes?: readonly string[] }): Promise<OAuthAccessTokenVerification>;
}

export type ConsumerCredentialResolution =
  | { readonly kind: "not-handled" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "verified";
      readonly credential: {
        readonly credential: Extract<CredentialKind, "api-key" | "personal-token">;
        readonly credentialId: string | null;
        /** The application subject key. A machine credential names its own stable one (say `key:<id>`): every Caller has a subject. */
        readonly subject: string;
        readonly clientId?: string | null;
        readonly scopes?: readonly string[];
      };
    };

export interface CallerResolverOptions {
  /** Where a service recognises and verifies its own credential formats; Core never stores or issues them. */
  readonly credentialResolver?: (request: Request) => ConsumerCredentialResolution | Promise<ConsumerCredentialResolution>;
  /** Enables OAuth access tokens, verified against the Auth's issuer and JWKS. `scopes` is a server-wide floor. */
  readonly jwtBearer?: { readonly audience: string; readonly scopes?: readonly string[] };
  /** Informational, copied to `Caller.issuer`. */
  readonly issuer?: string;
}

const STAFF = new Set<string>(STAFF_ROLES);
const invalid = (challenge: string, status?: 401 | 403) => ({ invalid: true as const, challenge, ...(status ? { status } : {}) });

export function createCallerResolver(auth: AuthLike, options: CallerResolverOptions = {}): CallerResolver {
  const user = async (subject: string, credential: CredentialKind, credentialId: string | null, clientId: string | null, scopes: readonly string[], role?: string | null): Promise<Caller> => {
    const current = role !== undefined ? role : await auth.getUserRole(subject);
    return {
      kind: "user", subject, ...(options.issuer ? { issuer: options.issuer } : {}),
      role: current && STAFF.has(current) ? (current as StaffRole) : null, scopes, credential, credentialId, clientId,
    };
  };

  return async (request) => {
    if (options.credentialResolver) {
      const r = await options.credentialResolver(request);
      if (r.kind === "invalid") return invalid('Bearer error="invalid_token"');
      if (r.kind === "verified") {
        const c = r.credential;
        return { caller: await user(c.subject, c.credential, c.credentialId, c.clientId ?? null, c.scopes ?? []) };
      }
    }

    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      // MCP clients use DPoP (sender-constrained) tokens; the verifier checks the proof
      const m = /^(Bearer|DPoP) ([^\s]+)$/i.exec(authorization);
      if (!m || !options.jwtBearer) return invalid('Bearer error="invalid_token"');
      const scheme = m[1]!.toLowerCase() === "dpop" ? "DPoP" : "Bearer";
      const v = await auth.verifyOAuthAccessToken(request, { audience: options.jwtBearer.audience, scopes: options.jwtBearer.scopes });
      if (!v.ok) {
        const error = v.reason === "invalid-dpop-proof" ? "invalid_dpop_proof" : v.reason === "insufficient-scope" ? "insufficient_scope" : "invalid_token";
        const scope = v.missingScopes?.length ? `, scope="${v.missingScopes.join(" ")}"` : "";
        return invalid(`${scheme} error="${error}"${scope}`, v.status);
      }
      return { caller: await user(v.userId, "oauth", v.credentialId, v.clientId, v.scopes, v.currentRole) };
    }

    const session = await auth.getSession(request);
    if (!session) return { caller: { kind: "anonymous" } };
    const caller = await user(session.user.id, "session", session.session.id, null, [], session.user.roleCurrent ? (session.user.role ?? null) : undefined);
    const { email, name, image, githubLogin } = session.user;
    return { caller: email === undefined && name === undefined ? caller : rememberSessionUser(caller, { email: email ?? "", name: name ?? "", image: image ?? null, githubLogin: githubLogin ?? null }) };
  };
}
