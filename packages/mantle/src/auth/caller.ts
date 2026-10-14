/**
 * Request -> Caller with Better Auth's own API only: no cookie signing, expiry, refresh, revocation or token rule is
 * re-implemented here. Nothing in this module imports Better Auth statically, so a public route that never calls
 * `resolveCaller` never loads it, and a request without credentials never loads it either.
 */
import type { BetterAuthOptions } from "better-auth/types";
import { ContractError, type Caller } from "../kernel/contracts.js";
import { userCaller } from "../kernel/user-caller.js";
import type { UserFields } from "../kernel/user-fields.js";

type User = { name?: string | null; email?: string | null; image?: string | null; githubLogin?: string | null; id: string; role?: string | null; banned?: boolean | null; banExpires?: Date | string | number | null };
const sessionUsers = new WeakMap<Caller, User>();
/** Display identity from the session this Caller already resolved; never an authority source. */
export const sessionUserOf = (caller: Caller): Readonly<User> | undefined => sessionUsers.get(caller);
/** The admin plugin's ban, lapsed once `banExpires` has passed (as the plugin reads it at sign-in). */
const isBanned = (user: User) => !!user.banned && (user.banExpires == null || new Date(user.banExpires).getTime() > Date.now());
/** The application's `betterAuth()` instance, as far as Caller resolution reads it. */
export interface AuthInstance {
  readonly options: BetterAuthOptions;
  readonly $context: Promise<unknown>;
  readonly api: { getSession(input: { headers: Headers; query?: { disableCookieCache?: boolean; disableRefresh?: boolean }; returnHeaders: true }): Promise<{ headers: Headers | null; response: { session: { id: string }; user: User } | null }> };
}

/** Better Auth owns the role model; absence of its admin plugin grants no admin layer. */
const adminRoles = new WeakMap<object, readonly string[]>();
export function adminRolesOf(auth: Pick<AuthInstance, "options">): readonly string[] {
  const cached = adminRoles.get(auth);
  if (cached) return cached;
  const plugin = auth.options.plugins?.find(plugin => plugin.id === "admin") as { options?: { adminRoles?: string | readonly string[] } } | undefined;
  const configured = plugin?.options?.adminRoles ?? ["admin"];
  const roles = Object.freeze(plugin ? typeof configured === "string" ? configured.split(",") : [...configured] : []);
  adminRoles.set(auth, roles);
  return roles;
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
      if (auth.options.secondaryStorage && !auth.options.session?.storeSessionInDatabase) throw new ContractError("AUTH_CONFIGURATION_ERROR", "Session secondaryStorage requires session.storeSessionInDatabase: true.", "auth:session");
      adminRolesOf(auth);
      return auth;
    }).catch((error) => { instance = undefined; throw error; }),
  };
}

/**
 * The Caller for a request that is not public. Public routes must not call it.
 * - `Authorization: Bearer`: an OAuth access token verified by Better Auth's resource client for `audience`; an invalid
 *   token is UNAUTHENTICATED, never anonymous. The user (role, ban) is read from the database on every request.
 * - Otherwise a session cookie, validated by `auth.api.getSession` without the cookie cache, so revocation and role
 *   changes apply on the next request. `readOnly: true` explicitly permits a bounded official cookie snapshot
 *   only with no secondaryStorage and cookieCache {enabled:true,maxAge:1..60,refreshCache:false}.
 *   The application classifies reads; HTTP method alone is not sufficient. No cookie means anonymous without loading Better Auth.
 *   When Better Auth extends the session (`updateAge`) it sets a fresh cookie: pass the outgoing response's headers as
 *   `responseHeaders` and those Set-Cookie lines are appended, so the browser cookie slides with the session.
 */
export async function resolveCaller(request: Request, auth: AuthLoader, options: { readonly fields?: UserFields; readonly audience?: string | readonly string[]; readonly readOnly?: boolean; readonly responseHeaders?: Headers; readonly scopes?: readonly string[]; readonly resolveCredential?: (request: Request) => Caller | null | Promise<Caller | null> } = {}): Promise<Caller> {
  const lacks = (have: readonly string[]) => options.scopes?.some(scope => !have.includes(scope));
  const supplied = await options.resolveCredential?.(request);
  if (supplied) {
    if (supplied.kind !== "user" || supplied.credential === "session") throw new ContractError("UNAUTHENTICATED", "Invalid service credential.");
    if (lacks(supplied.scopes)) throw new ContractError("AUTH_DENIED", "The service credential lacks a required scope.");
    const instance = await auth.get();
    for (const field of Object.keys(options.fields ?? {})) {
      const additional = instance.options.user?.additionalFields;
      const stored = additional && Object.hasOwn(additional, field) ? additional[field] : undefined;
      if (!(stored ? stored.input === false : instance.options.plugins?.some(plugin => plugin.id === "custom-session")))
        throw new ContractError("AUTH_CONFIGURATION_ERROR", `User field '${field}' requires an input: false additional field or a customSession source.`, "auth:user");
    }
    const context = options.fields && Object.keys(options.fields).length ? await instance.$context as import("@better-auth/core").AuthContext : undefined;
    const user = context ? await context.internalAdapter.findUserById(supplied.subject) : { id: supplied.subject, role: supplied.role };
    if (!user || isBanned(user)) throw new ContractError("UNAUTHENTICATED", "The service credential's user is not active.");
    return userCaller({ ...user, id: user.id }, { fields: options.fields, adminRoles: adminRolesOf(instance), credential: supplied.credential, credentialId: supplied.credentialId, clientId: supplied.clientId, scopes: supplied.scopes, issuer: supplied.issuer });
  }
  const authorization = request.headers.get("authorization");
  if (authorization && /^(bearer|dpop) /i.test(authorization)) {
    if (!options.audience) throw new ContractError("UNAUTHENTICATED", "This route does not accept access tokens.");
    const instance = await auth.get();
    for (const field of Object.keys(options.fields ?? {})) {
      const additional = instance.options.user?.additionalFields;
      const stored = additional && Object.hasOwn(additional, field) ? additional[field] : undefined;
      if (!(stored ? stored.input === false : instance.options.plugins?.some(plugin => plugin.id === "custom-session")))
        throw new ContractError("AUTH_CONFIGURATION_ERROR", `User field '${field}' requires an input: false additional field or a customSession source.`, "auth:user");
    }
    const { oauthProviderResourceClient } = await import("@better-auth/oauth-provider/resource-client");
    const { createDpopReplayStore } = await import("better-auth/oauth2");
    const context = await instance.$context as import("@better-auth/core").AuthContext;
    const verifier = oauthProviderResourceClient(instance).getActions();
    let claims: Awaited<ReturnType<typeof verifier.verifyAccessTokenRequest>>;
    try {
      claims = await verifier.verifyAccessTokenRequest(request, { verifyOptions: { audience: options.audience as string | string[] }, dpop: { replayStore: createDpopReplayStore(context.internalAdapter) } });
    } catch (cause) {
      throw new ContractError("UNAUTHENTICATED", "The access token is not valid for this resource.", "", { cause });
    }
    const { assertActiveUserGrant } = await import("./oauth.js");
    const granted = await assertActiveUserGrant(instance, claims, options.audience);
    const user = granted && options.fields && Object.keys(options.fields).length ? await context.internalAdapter.findUserById(granted.id) : granted;
    const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
    if (lacks(scopes)) throw new ContractError("AUTH_DENIED", "The access token lacks a required scope.");
    if (!user || isBanned(user)) throw new ContractError("UNAUTHENTICATED", "The access token's user is not active.");
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    return userCaller({ ...user, id: user.id }, { fields: options.fields, adminRoles: adminRolesOf(instance), issuer: claims.iss, scopes, credential: "oauth", credentialId: text(claims.jti), clientId: text(claims.azp) ?? text(claims.client_id) });
  }
  if (authorization !== null) throw new ContractError("UNAUTHENTICATED", "The authorization header is not a supported credential.");
  // With no Cookie header at all getSessionCookie returns null: skip even loading the helper.
  if (!request.headers.has("cookie")) return { kind: "anonymous" };
  const { getSessionCookie, splitSetCookieHeader } = await import("better-auth/cookies");
  if (!getSessionCookie(request, { cookiePrefix: auth.cookiePrefix })) return { kind: "anonymous" };
  const instance = await auth.get();
  for (const field of Object.keys(options.fields ?? {})) {
    const additional = instance.options.user?.additionalFields;
    const stored = additional && Object.hasOwn(additional, field) ? additional[field] : undefined;
    if (!(stored ? stored.input === false : instance.options.plugins?.some(plugin => plugin.id === "custom-session")))
      throw new ContractError("AUTH_CONFIGURATION_ERROR", `User field '${field}' requires an input: false additional field or a customSession source.`, "auth:user");
  }
  const mirror = !!instance.options.secondaryStorage;
  const cache = instance.options.session?.cookieCache;
  // Only an application-classified read may use Better Auth's bounded signed snapshot. KV remains primary-guarded.
  const cachedRead = options.readOnly === true && !mirror && cache?.enabled === true && cache.refreshCache === false &&
    typeof cache.maxAge === "number" && cache.maxAge >= 1 && cache.maxAge <= 60;
  const initial = await instance.api.getSession({ headers: request.headers, query: { disableCookieCache: !cachedRead, disableRefresh: mirror || !options.responseHeaders }, returnHeaders: true });
  const found = initial.response;
  if (!found) return { kind: "anonymous" };
  let user: User | null = found.user;
  if (mirror) {
    // disableCookieCache bypasses browser cookies, not KV. Only mirrors need a primary authority re-read.
    if (!instance.options.session?.storeSessionInDatabase)
      throw new ContractError("AUTH_CONFIGURATION_ERROR", "Caller resolution with secondaryStorage requires session.storeSessionInDatabase: true.", "auth:session");
    const context = await instance.$context as import("@better-auth/core").AuthContext;
    const live = await context.adapter.findOne<{ userId: string; expiresAt: Date | string | number; user: User | null }>({ model: "session", where: [{ field: "id", value: found.session.id }], join: { user: true } });
    if (!live || live.userId !== found.user.id || !(new Date(live.expiresAt).getTime() > Date.now())) return { kind: "anonymous" };
    user = live.user;
    // Stored values come from the primary record; derived values exist only in customSession's verified response.
    if (user && options.fields) {
      const additional = instance.options.user?.additionalFields;
      for (const field of Object.keys(options.fields)) {
        if ((!additional || !Object.hasOwn(additional, field)) && Object.hasOwn(found.user, field))
          user = { ...user, [field]: (found.user as User & Record<string, unknown>)[field] };
      }
    }
  }
  if (!user || isBanned(user)) return { kind: "anonymous" };
  // Never let a stale secondary snapshot extend an already-expired primary session before the check above.
  if (options.responseHeaders) {
    const refreshed = mirror ? await instance.api.getSession({ headers: request.headers, query: { disableCookieCache: true }, returnHeaders: true }) : initial;
    if (!refreshed.response || refreshed.response.session.id !== found.session.id || refreshed.response.user.id !== user.id) return { kind: "anonymous" };
    for (const cookie of refreshed.headers?.getSetCookie().flatMap(splitSetCookieHeader) ?? []) options.responseHeaders.append("set-cookie", cookie);
  }
  const caller: Caller = userCaller({ ...user, id: user.id }, { fields: options.fields, adminRoles: adminRolesOf(instance), credentialId: found.session.id });
  sessionUsers.set(caller, user);
  return caller;
}
