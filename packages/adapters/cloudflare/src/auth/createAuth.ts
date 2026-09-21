import type {
  AuthSessionCache,
  CreateMantleAuthOptions,
  MantleAuth,
} from "@aotter/mantle-auth";
import { createMantleAuth } from "@aotter/mantle-auth";
import { D1DatabaseDriver } from "../bindings/D1DatabaseDriver.js";

/** Ingress header Cloudflare overwrites. `createAuth` always passes this
 *  to the portable package; callers do not configure it. */
export const CLOUDFLARE_CLIENT_IP_HEADERS = ["cf-connecting-ip"] as const;

// Stable Cloudflare-facing surface. Explicit names only — do not star-export
// `@aotter/mantle-auth` (that would leak the portable constructor and make
// the Cloudflare header look like a portable default).
export {
  STAFF_ROLE_SET,
  STAFF_ROLES,
  buildGenericOAuthProviders,
  buildOAuthProviderOptions,
  buildSocialProviders,
  buildTrustedOriginsFor,
  createSetupIncompleteAuth,
  decodeMemberCursor,
  encodeMemberCursor,
  getProviderAccessTokenForRequest,
  guardGithubLoginProfile,
  hasEmailAuthSurface,
  hashEmailOtp,
  isSetupIncompleteAuth,
  mapRegisteredOAuthClient,
  normalizeAuthBasePath,
  normalizeAuthResponseCookies,
  pickLocale,
  shouldPromoteToOwner,
  validateBootstrap,
  verifyOAuthJwt,
  verifyOAuthJwtWithLocalJwks,
} from "@aotter/mantle-auth";
export type {
  AuthMethodConfig,
  AuthMethodInfo,
  AuthSessionCache,
  AuthUserInfo,
  BootstrapOwnerRule,
  CrossSubDomainCookiesConfig,
  InviteUserResult,
  LinkedAccountInfo,
  ListMembersArgs,
  MantleAuth,
  MemberListResult,
  MemberUserInfo,
  OAuthAccessTokenVerification,
  OAuthConsentInfo,
  OAuthConsentRequest,
  OAuthProviderConfig,
  ProviderAccessToken,
  RegisterOAuthClientInput,
  RegisteredOAuthClient,
  SetupIncompleteAuthOptions,
  SocialProviderId,
  StaffRole,
  StaffUserInfo,
} from "@aotter/mantle-auth";
export type { MantleAuth as Auth } from "@aotter/mantle-auth";

/** Workers KV as a Better Auth session cache. Key naming and TTL policy stay
 *  in `@aotter/mantle-auth`; this only stores what it is handed. */
export function kvSessionCache(kv: KVNamespace): AuthSessionCache {
  return {
    get: (key) => kv.get(key),
    set: (key, value, ttlSeconds) =>
      kv.put(key, value, ttlSeconds ? { expirationTtl: ttlSeconds } : undefined),
    delete: (key) => kv.delete(key),
  };
}

export interface CreateAuthConfig
  extends Omit<
    CreateMantleAuthOptions,
    "database" | "driver" | "sessionCache" | "ipAddressHeaders"
  > {
  readonly database: D1Database;
  /** Deployment-owned KV used by Better Auth for session reads. Session rows
   * stay in D1; verification codes and rate limits never use eventually
   * consistent KV. */
  readonly sessionCacheKv?: KVNamespace;
}

/** Better Auth on Cloudflare: D1 for state, optional Workers KV for session
 *  reads. Wiring only — the auth surface itself is host-neutral. Always
 *  supplies `cf-connecting-ip` as the rate-limit identity header. */
export function createAuth(config: CreateAuthConfig): MantleAuth {
  const { database, sessionCacheKv, ...rest } = config;
  return createMantleAuth({
    ...rest,
    database,
    driver: new D1DatabaseDriver(database),
    sessionCache: sessionCacheKv ? kvSessionCache(sessionCacheKv) : undefined,
    ipAddressHeaders: CLOUDFLARE_CLIENT_IP_HEADERS,
  });
}
