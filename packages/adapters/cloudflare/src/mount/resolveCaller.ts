import type { HandlerContext } from "@aotter/mantle-runtime";
import {
  runtimeDiagnostic,
  type Diagnostic,
  type StaffRole,
} from "@aotter/mantle-spec";
import { STAFF_ROLE_SET, type Auth } from "../auth/createAuth.js";

export type ConsumerCredentialResolution =
  | { readonly kind: "not-handled" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "verified";
      readonly credential: {
        readonly credential: "api-key" | "personal-token";
        readonly credentialId: string | null;
        readonly userId: string | null;
        readonly clientId?: string | null;
        readonly scopes?: readonly string[];
      };
    };

/** Adapter-owned extension seam. Consumers recognize and verify their
 * own credential formats here; Core never stores or issues them. */
export type ConsumerCredentialResolver = (
  request: Request,
) => ConsumerCredentialResolution | Promise<ConsumerCredentialResolution>;

export interface ResolveCallerOptions {
  readonly auth: Auth;
  readonly credentialResolver?: ConsumerCredentialResolver;
  /** Enables JWT bearer verification against this Auth issuer/JWKS. */
  readonly jwtBearer?: {
    readonly audience: string;
    /** Optional server-wide floor. Manifest operation scopes are still
     * evaluated by the runtime's ctx.auth.scope predicates. */
    readonly scopes?: readonly string[];
  };
  readonly env?: unknown;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export type CallerResolution =
  | {
      readonly kind: "anonymous" | "authenticated";
      readonly context: HandlerContext;
    }
  | {
      readonly kind: "invalid";
      readonly status: 401 | 403;
      readonly diagnostic: Diagnostic;
    };

/** Normalize consumer credentials, OAuth bearer, or cookie session in
 * that precedence order. A presented-but-invalid credential never
 * falls back to a valid session cookie. */
export async function resolveCaller(
  request: Request,
  options: ResolveCallerOptions,
): Promise<CallerResolution> {
  const base = {
    env: options.env ?? {},
    ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
  };

  if (options.credentialResolver) {
    const resolved = await options.credentialResolver(request);
    if (resolved.kind === "invalid") return invalidCredential(401);
    if (resolved.kind === "verified") {
      const credential = resolved.credential;
      return {
        kind: "authenticated",
        context: await contextForVerifiedUser(
          credential.userId,
          {
            credential: credential.credential,
            credentialId: credential.credentialId,
            clientId: credential.clientId ?? null,
            scopes: credential.scopes ?? [],
          },
          options.auth,
          base,
        ),
      };
    }
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
    if (!token) {
      return invalidCredential(401);
    }
    if (!options.jwtBearer) return invalidCredential(401);
    const verified = await options.auth.verifyOAuthAccessToken(request, {
      audience: options.jwtBearer.audience,
      scopes: options.jwtBearer.scopes,
    });
    if (!verified.ok) return invalidCredential(verified.status);
    return {
      kind: "authenticated",
      context: await contextForVerifiedUser(
        verified.userId,
        {
          credential: "oauth",
          credentialId: verified.credentialId,
          clientId: verified.clientId,
          scopes: verified.scopes,
        },
        options.auth,
        base,
      ),
    };
  }

  const session = await options.auth.getSession(request);
  if (!session) {
    return {
      kind: "anonymous",
      context: { user: null, staff: null, ...base },
    };
  }
  return {
    kind: "authenticated",
    context: await contextForVerifiedUser(
      session.user.id,
      {
        credential: "session",
        credentialId: session.session.id,
        clientId: null,
        scopes: [],
      },
      options.auth,
      base,
    ),
  };
}

export async function contextForVerifiedUser(
  userId: string | null,
  authContext: NonNullable<HandlerContext["auth"]>,
  auth: Auth,
  base: Pick<HandlerContext, "env" | "waitUntil">,
): Promise<HandlerContext> {
  const role = userId ? await auth.getUserRole(userId) : null;
  const staff =
    userId && role && STAFF_ROLE_SET.has(role)
      ? { id: userId, role: role as StaffRole }
      : null;
  return {
    user: userId ? { id: userId } : null,
    staff,
    auth: authContext,
    ...base,
  };
}

function invalidCredential(status: 401 | 403): CallerResolution {
  return {
    kind: "invalid",
    status,
    diagnostic: runtimeDiagnostic({
      code: status === 401 ? "UNAUTHENTICATED" : "AUTH_DENIED",
      severity: "error",
      path: "request:authorization",
      expected:
        status === 401
          ? "a valid configured credential"
          : "a verified credential with the required scope",
      message:
        status === 401
          ? "The presented credential is missing, malformed, expired, revoked, or invalid."
          : "The verified credential lacks a required server scope.",
    }),
  };
}
