import type { HandlerContext } from "@aotter/mantle-runtime";
import {
  runtimeDiagnostic,
  type Diagnostic,
  type StaffRole,
} from "@aotter/mantle-spec";
import { STAFF_ROLE_SET, type MantleAuth as Auth } from "@aotter/mantle-auth";
import { rejectCrossOriginMutation } from "@aotter/mantle-admin";

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
  /** Optional observability wrapper around the two I/O steps: bearer
   *  verification (`oauth`) and the fresh role read (`role`). */
  readonly phase?: PhaseHook;
}

export type PhaseHook = <T>(phase: "oauth" | "role", run: () => Promise<T>) => Promise<T>;
const runDirect: PhaseHook = (_phase, run) => run();

export type CallerResolution =
  | {
      readonly kind: "anonymous" | "authenticated";
      readonly context: HandlerContext;
    }
  | {
      readonly kind: "invalid";
      readonly status: 401 | 403;
      readonly diagnostic: Diagnostic;
      /** Verifier reason (e.g. `invalid-dpop-proof`) for transports that render a challenge. */
      readonly reason: string;
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
  const phase = options.phase ?? runDirect;

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
          undefined,
          phase,
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
    const jwtBearer = options.jwtBearer;
    const verified = await phase("oauth", () => options.auth.verifyOAuthAccessToken(request, {
      audience: jwtBearer.audience,
      scopes: jwtBearer.scopes,
    }));
    if (!verified.ok) return invalidCredential(verified.status, verified.reason);
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
        undefined,
        phase,
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
      session.user.roleCurrent ? session.user.role ?? null : undefined,
      phase,
    ),
  };
}

export async function contextForVerifiedUser(
  userId: string | null,
  authContext: NonNullable<HandlerContext["auth"]>,
  auth: Auth,
  base: Pick<HandlerContext, "env" | "waitUntil">,
  currentRole?: string | null,
  phase: PhaseHook = runDirect,
): Promise<HandlerContext> {
  const role = currentRole !== undefined
    ? currentRole
    : userId ? await phase("role", () => auth.getUserRole(userId)) : null;
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

function invalidCredential(status: 401 | 403, reason?: string): CallerResolution {
  return {
    kind: "invalid",
    status,
    reason: reason ?? (status === 403 ? "insufficient-scope" : "invalid-credential"),
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

/** Which callers a transport surface admits before the target's own `requires` runs. */
export type SurfacePolicy = "public" | "staff";

export type CallerGate =
  | { readonly kind: "allow"; readonly context: HandlerContext }
  | {
      readonly kind: "deny";
      readonly status: 401 | 403;
      readonly diagnostic: Diagnostic;
      /** `invalid-credential`, `invalid-dpop-proof`, `insufficient-scope`, `cross-origin`, `unauthenticated` or `insufficient-role`. */
      readonly reason: string;
    };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The one caller gate every transport shares (#977). It resolves identity
 * through `resolveCaller`, applies the cross-origin guard only when the
 * credential is a cookie session, and lets `surface` decide exactly one
 * thing: whether `ctx.staff` is required. `public` admits anonymous callers;
 * the target's `requires.auth` and guard still run on every invocation, so
 * enforcement stays where the manifest declares it rather than at the
 * transport. Transports differ only in how they render a denial.
 */
export async function gateCaller(
  request: Request,
  options: ResolveCallerOptions & { readonly surface?: SurfacePolicy },
): Promise<CallerGate> {
  const caller = await resolveCaller(request, options);
  if (caller.kind === "invalid") {
    return { kind: "deny", status: caller.status, diagnostic: caller.diagnostic, reason: caller.reason };
  }
  if (caller.context.auth?.credential === "session" && !SAFE_METHODS.has(request.method)) {
    const rejected = rejectCrossOriginMutation(request);
    if (rejected) {
      return {
        kind: "deny",
        status: 403,
        reason: "cross-origin",
        diagnostic: runtimeDiagnostic({
          code: "AUTH_DENIED",
          severity: "error",
          path: "request:origin",
          expected: "a same-origin request when the credential is a cookie session",
          message: "Cross-origin session mutation rejected.",
        }),
      };
    }
  }
  if (options.surface === "staff" && !caller.context.staff) {
    const anonymous = caller.kind === "anonymous";
    return {
      kind: "deny",
      status: anonymous ? 401 : 403,
      reason: anonymous ? "unauthenticated" : "insufficient-role",
      diagnostic: runtimeDiagnostic({
        code: anonymous ? "UNAUTHENTICATED" : "AUTH_DENIED",
        severity: "error",
        path: "request:surface",
        expected: "a staff caller on the staff surface",
        message: anonymous
          ? "The staff surface requires a signed-in staff caller."
          : "The caller is signed in but holds no staff role.",
      }),
    };
  }
  return { kind: "allow", context: caller.context };
}
