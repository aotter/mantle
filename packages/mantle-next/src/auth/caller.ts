/**
 * Request -> Caller with Better Auth's own API only: no cookie signing, expiry, refresh, revocation or token rule is
 * re-implemented here. Nothing in this module imports Better Auth statically, so a public route that never calls
 * `resolveCaller` never loads it, and a request without credentials never loads it either.
 */
import type { BetterAuthOptions } from "better-auth/types";
import { ContractError, type Caller } from "../kernel/contracts.js";

type User = { id: string; role?: string | null; banned?: boolean | null; banExpires?: Date | string | number | null };
/** The admin plugin's ban, lapsed once `banExpires` has passed (as the plugin reads it at sign-in). */
const isBanned = (user: User) => !!user.banned && (user.banExpires == null || new Date(user.banExpires).getTime() > Date.now());
/** The application's `betterAuth()` instance, as far as Caller resolution reads it. */
export interface AuthInstance {
  readonly options: BetterAuthOptions;
  readonly $context: Promise<unknown>;
  readonly api: { getSession(input: { headers: Headers; query?: { disableCookieCache?: boolean }; returnHeaders: true }): Promise<{ headers: Headers | null; response: { session: { id: string }; user: User } | null }> };
}

export interface AuthLoader<A extends AuthInstance = AuthInstance> {
  /** `advanced.cookiePrefix` of the same options; read before Better Auth loads. */
  readonly cookiePrefix: string;
  /** The instance, imported on first use and checked against `cookiePrefix`. */
  readonly get: () => Promise<A>;
}

/**
 * `load` should be a dynamic import of the module that builds `betterAuth()`, so the bundler keeps it (and Better Auth)
 * out of the entry module: `authLoader(() => import("./auth.js").then(m => m.auth))`.
 */
export function authLoader<A extends AuthInstance>(load: () => Promise<A>, cookiePrefix = "better-auth"): AuthLoader<A> {
  let instance: Promise<A> | undefined;
  return {
    cookiePrefix,
    get: () => instance ??= load().then((auth) => {
      // Better Auth's getSessionCookie looks the cookie up by prefix only: any other spelling would make every signed-in user anonymous.
      if ((auth.options.advanced?.cookiePrefix ?? "better-auth") !== cookiePrefix) throw new Error(`authLoader cookiePrefix '${cookiePrefix}' differs from the auth options' advanced.cookiePrefix.`);
      if (auth.options.advanced?.cookies?.session_token?.name) throw new Error("advanced.cookies.session_token.name is not supported: Better Auth's getSessionCookie cannot find a renamed session cookie.");
      return auth;
    }).catch((error) => { instance = undefined; throw error; }),
  };
}

const STAFF = new Set(["owner", "editor", "contributor"]);
const roleOf = (user: User) => (user.role && STAFF.has(user.role) ? user.role as "owner" | "editor" | "contributor" : null);

/**
 * The Caller for a request that is not public. Public routes must not call it.
 * - `Authorization: Bearer`: an OAuth access token verified by Better Auth's resource client for `audience`; an invalid
 *   token is UNAUTHENTICATED, never anonymous. The user (role, ban) is read from the database on every request.
 * - Otherwise a session cookie, validated by `auth.api.getSession` without the cookie cache, so revocation and role
 *   changes apply on the next request. No session cookie means anonymous, without loading Better Auth.
 *   When Better Auth extends the session (`updateAge`) it sets a fresh cookie: pass the outgoing response's headers as
 *   `responseHeaders` and those Set-Cookie lines are appended, so the browser cookie slides with the session.
 */
export async function resolveCaller(request: Request, auth: AuthLoader, options: { readonly audience?: string | readonly string[]; readonly responseHeaders?: Headers } = {}): Promise<Caller> {
  const authorization = request.headers.get("authorization");
  if (authorization && /^(bearer|dpop) /i.test(authorization)) {
    if (!options.audience) throw new ContractError("UNAUTHENTICATED", "This route does not accept access tokens.");
    const instance = await auth.get();
    const { oauthProviderResourceClient } = await import("@better-auth/oauth-provider/resource-client");
    const verifier = oauthProviderResourceClient(instance).getActions();
    let claims: Awaited<ReturnType<typeof verifier.verifyAccessTokenRequest>>;
    try {
      claims = await verifier.verifyAccessTokenRequest(request, { verifyOptions: { audience: options.audience as string | string[] } });
    } catch (cause) {
      throw new ContractError("UNAUTHENTICATED", "The access token is not valid for this resource.", "", { cause });
    }
    const context = await instance.$context as { internalAdapter: { findUserById(id: string): Promise<User | null> } };
    const user = claims.sub ? await context.internalAdapter.findUserById(claims.sub) : null;
    if (!user || isBanned(user)) throw new ContractError("UNAUTHENTICATED", "The access token's user is not active.");
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    return { kind: "user", subject: user.id, issuer: claims.iss, role: roleOf(user), scopes: text(claims.scope)?.split(" ").filter(Boolean) ?? [], credential: "oauth", credentialId: text(claims.jti), clientId: text(claims.azp) ?? text(claims.client_id) };
  }
  // With no Cookie header at all getSessionCookie returns null: skip even loading the helper.
  if (!request.headers.has("cookie")) return { kind: "anonymous" };
  const { getSessionCookie } = await import("better-auth/cookies");
  if (!getSessionCookie(request, { cookiePrefix: auth.cookiePrefix })) return { kind: "anonymous" };
  const { headers, response: found } = await (await auth.get()).api.getSession({ headers: request.headers, query: { disableCookieCache: true }, returnHeaders: true });
  for (const cookie of headers?.getSetCookie() ?? []) options.responseHeaders?.append("set-cookie", cookie);
  // Better Auth's getSession does not look at `banned` for an existing session; the bearer path above already refuses it.
  if (!found || isBanned(found.user)) return { kind: "anonymous" };
  return { kind: "user", subject: found.user.id, role: roleOf(found.user), scopes: [], credential: "session", credentialId: found.session.id, clientId: null };
}
