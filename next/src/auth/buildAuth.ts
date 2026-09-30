/** One Better Auth instance from `CreateMantleAuthOptions`: plugins, staff roles, database hooks and the session cache. */
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, jwt } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { AsyncLocalStorage } from "node:async_hooks";
import { readStoreInstanceId } from "../d1/index.js";
import { STAFF_ROLES } from "../spec/domain/index.js";
import { dbOf } from "./db.js";

import { type AuthHookContext, buildEmailOTPPlugin, buildGenericOAuthProviders, buildMagicLinkPlugin, buildOAuthProviderOptions, buildSocialProviders, buildTrustedOriginsFor, guardGithubLoginProfile, hasEmailAuthSurface, methodsRequireSameSiteNone, normalizeAuthBasePath, normalizeAuthErrorURL, pickSingleton, resolveClientIpHeaders, shouldPromoteToOwner, validateBootstrap } from "./methods.js";
import type { BackgroundTaskRetainer, CreateMantleAuthOptions } from "./types.js";
// Better Auth 1.7.2 initializes its shared stores asynchronously. Seed them
// before any request can be canceled; the accessor-identity regression test
// pins this version-specific integration to the stores Better Auth uses.
const betterAuthGlobalKey = Symbol.for("better-auth:global");
const betterAuthGlobals = globalThis as typeof globalThis & {
  [key: symbol]: BetterAuthGlobal | undefined;
};
const betterAuthGlobal = betterAuthGlobals[betterAuthGlobalKey] ??= {
  version: "",
  epoch: 0,
  context: {},
};
betterAuthGlobal.context.requestStateAsyncStorage ??= new AsyncLocalStorage();
betterAuthGlobal.context.endpointContextAsyncStorage ??= new AsyncLocalStorage();
betterAuthGlobal.context.adapterAsyncStorage ??= new AsyncLocalStorage();

/**
 * Request-scoped retention for Better Auth's fire-and-forget work. Better Auth
 * hands `advanced.backgroundTasks.handler` a bare promise with no request in
 * sight; the handler reads the retainer the current `handler()` call stored
 * here and registers the promise with it. On Workers that retainer is
 * `ExecutionContext.waitUntil` — without it the OTP send and the rate-limit
 * cleanup can be cancelled the moment the response is returned (#976).
 */
export const backgroundTaskRetention = new AsyncLocalStorage<BackgroundTaskRetainer>();

interface BetterAuthGlobal {
  version: string;
  epoch: number;
  context: Record<string, unknown>;
}

const ac = createAccessControl(defaultStatements);

const ownerAc = ac.newRole({
  user: defaultStatements.user,
  session: defaultStatements.session,
});
const editorAc = ac.newRole({
  user: ["list", "ban", "get", "update"],
  session: ["list", "revoke"],
});
const contributorAc = ac.newRole({
  user: ["list", "get"],
  session: [],
});
const userAc = ac.newRole({
  user: [],
  session: [],
});

export function buildAuth(config: CreateMantleAuthOptions) {
  const db = dbOf(config.driver);
  const ipAddressHeaders = resolveClientIpHeaders(config.ipAddressHeaders);
  if (config.hostOnlyCookies && (new URL(config.baseURL).protocol !== "https:" || config.crossSubDomainCookies?.enabled)) {
    throw new Error("createMantleAuth: hostOnlyCookies requires HTTPS and cannot share cookies across subdomains.");
  }
  if (config.methods.length === 0 && !config.plugins?.length) {
    throw new Error("createMantleAuth: methods[] is empty — register an AuthMethodConfig or native Better Auth plugin so staff can sign in.");
  }
  if (config.bootstrapOwner) {
    validateBootstrap(config.bootstrapOwner, config.methods);
  }
  const socialProviders = buildSocialProviders(config.methods);
  const genericOAuthProviders = buildGenericOAuthProviders(config.methods);
  const bootstrap = config.bootstrapOwner;
  const emailOtpMethod = pickSingleton(config.methods, "email-otp");
  const magicLinkMethod = pickSingleton(config.methods, "magic-link");
  const providerOptions = config.oauthProvider
    ? buildOAuthProviderOptions(config.oauthProvider)
    : null;

  // Workers may not set NODE_ENV. Explicitly enable the provider's route
  // limits too (notably anonymous DCR: 5/minute).
  // ponytail: memory limits are per isolate; use an ingress rate-limit rule
  // when a deployment needs a distributed abuse quota.
  const hasEmailMethod = hasEmailAuthSurface(config.methods, config.plugins);
  const rateLimit = {
    window: 60,
    max: hasEmailMethod ? 10 : 100,
    ...config.rateLimit,
    enabled: true as const,
    storage: "memory" as const,
  };

  // `trustedOrigins`: per-provider auto-origins (Apple needs
  // `https://appleid.apple.com`) plus adopter-owned first-party
  // origins for flows such as hosted auth across trusted subdomains.
  const trustedOrigins = buildTrustedOriginsFor(config.methods, config.trustedOrigins);

  const sdkPlugins = [
    admin({
      defaultRole: "user",
      adminRoles: [...STAFF_ROLES],
      ac,
      roles: {
        owner: ownerAc,
        editor: editorAc,
        contributor: contributorAc,
        user: userAc,
      },
    }),
    ...(genericOAuthProviders.length > 0
      ? [
          genericOAuth({
            config: genericOAuthProviders,
          }),
        ]
      : []),
    ...(emailOtpMethod ? [buildEmailOTPPlugin(emailOtpMethod, config.secret)] : []),
    ...(magicLinkMethod ? [buildMagicLinkPlugin(magicLinkMethod)] : []),
    ...(config.oauthProvider && providerOptions
      ? [
          jwt(),
          config.oauthProvider.mcpResource
            ? mcp({
                ...providerOptions,
                resource: config.oauthProvider.mcpResource,
                extensions: [
                  {
                    claims: {
                      accessToken: ({ referenceId }) => ({ mantle_consent_id: referenceId ?? null }),
                    },
                  },
                  ...(config.oauthProvider.extensions ?? []),
                ],
              })
            : oauthProvider({
                ...providerOptions,
                ...(config.oauthProvider.extensions
                  ? { extensions: [...config.oauthProvider.extensions] }
                  : {}),
              }),
          ...(config.oauthProvider.mcpResource
            ? [
                cimd({
                  // Cloudflare's `global_fetch_strictly_public` flag is the
                  // runtime network boundary: resolution and connection stay
                  // on the public Internet. Better Auth owns timeout, limits,
                  // validation, caching, and redirect rejection above it.
                  // Workers does not implement `redirect: "error"`; `manual`
                  // exposes 3xx responses so Better Auth can reject them.
                  fetchClientMetadataResource: (input, init) =>
                    fetch(input, { ...init, redirect: "manual" }),
                  metadataProfile: "mcp-2026-07-28",
                }),
              ]
            : []),
        ]
      : []),
  ];
  const plugins = [...sdkPlugins, ...(config.plugins ?? [])];
  const pluginIds = new Set<string>();
  for (const plugin of plugins) {
    if (pluginIds.has(plugin.id)) {
      throw new Error(`createMantleAuth: Better Auth plugin '${plugin.id}' is registered more than once. Remove the duplicate plugin.`);
    }
    pluginIds.add(plugin.id);
  }

  // `user.additionalFields`: SDK owns `githubLogin` only.
  const userConfig = {
    additionalFields: {
      githubLogin: {
        type: "string" as const,
        required: false,
        // Better Auth applies `input: false` to trusted provider profiles too.
        // Database hooks below keep this field provider-only instead.
        input: true,
      },
    },
  };

  // `advanced`: SDK owns `backgroundTasks`. Apple auto-injects
  // `defaultCookieAttributes.sameSite: "none"` because Apple's
  // `form_post` callback is cross-site and a `lax` cookie won't ride
  // it (Better Auth's default raises a state-mismatch).
  const appleNeedsCrossSite = methodsRequireSameSiteNone(config.methods);
  const advancedConfig = {
    // Host adapter supplies the trusted ingress header(s). Never default to XFF.
    ipAddress: { ipAddressHeaders: [...ipAddressHeaders] },
    ...(appleNeedsCrossSite
      ? {
          // Browsers require `secure: true` whenever `sameSite: "none"`.
          defaultCookieAttributes: { secure: true, sameSite: "none" as const },
        }
      : {}),
    ...(config.crossSubDomainCookies
      ? { crossSubDomainCookies: config.crossSubDomainCookies }
      : {}),
    ...(config.cookiePrefix ? { cookiePrefix: config.cookiePrefix } : {}),
    ...(config.hostOnlyCookies ? {
      // Better Auth prepends __Secure- otherwise. Secure is set explicitly below.
      useSecureCookies: false,
      cookiePrefix: `__Host-${config.cookiePrefix || "better-auth"}`,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { secure: true, path: "/", ...(appleNeedsCrossSite ? { sameSite: "none" as const } : {}) },
    } : {}),
    // Fire-and-forget hook closes the user-existence timing oracle
    // on OTP send — see § "Auth as contract" notes in ADR-0014.
    backgroundTasks: {
      handler: (p: Promise<unknown>) => {
        const settled = p.then(() => undefined, (err) => {
          // eslint-disable-next-line no-console
          console.error("[better-auth backgroundTask]", err);
        });
        // Registered with the request's retainer when the host supplied one;
        // otherwise the work simply runs detached as before.
        backgroundTaskRetention.getStore()?.(settled);
      },
    },
  };

  // `databaseHooks`: SDK owns `user.create.after` for bootstrap-owner
  // promotion (when `bootstrapOwner` is configured).
  const sdkUserCreateAfter = async (user: unknown): Promise<void> => {
    if (!bootstrap) return;
    const u = user as {
      id: string;
      email?: string | null;
      githubLogin?: string | null;
    };
    if (!shouldPromoteToOwner(bootstrap, u)) return;

    // Atomic check-then-promote: the `NOT EXISTS` is a GLOBAL guard —
    // it asks "does any user already hold a staff role?". The whole
    // statement runs as one database op, so two concurrent first signups
    // can't both win: the loser's UPDATE finds a staff user in the
    // subquery and silently writes zero rows.
    const placeholders = STAFF_ROLES.map(() => "?").join(",");
    const result = await db.run(`UPDATE user SET role = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user WHERE role IN (${placeholders}))`, "owner", u.id, ...STAFF_ROLES);
    if ((result.meta?.changes ?? 0) === 0) {
      // Operator-visible signal that the rule matched but a prior
      // staff user already exists — otherwise the silent no-op makes a
      // misconfigured bootstrap rule indistinguishable from a working
      // first-promotion.
      console.warn(`[bootstrap] user ${u.id} matched bootstrapOwner rule but promotion was blocked — a staff user already exists.`);
    }
  };
  const databaseHooks: BetterAuthOptions["databaseHooks"] = {
    user: {
      create: {
        before: async (user: Readonly<Record<string, unknown>>, context: AuthHookContext) =>
          guardGithubLoginProfile(user, context, config.methods),
        after: sdkUserCreateAfter,
      },
      update: {
        before: async (user: Readonly<Record<string, unknown>>, context: AuthHookContext) =>
          guardGithubLoginProfile(user, context, config.methods),
      },
    },
    verification: {
      create: {
        before: async (verification) => {
          if (!config.oauthProvider?.mcpResource) return;
          let value;
          try {
            value = JSON.parse(verification.value) as {
              type?: unknown; userId?: unknown; query?: { client_id?: unknown };
            };
          } catch {
            return; // OTPs and other verification values are not OAuth grants.
          }
          if (value?.type !== "authorization_code" || typeof value.userId !== "string" ||
              typeof value.query?.client_id !== "string") return;
          const consent = await db.first<{ id: string }>("SELECT id FROM oauthConsent WHERE userId = ? AND clientId = ? LIMIT 1", value.userId, value.query.client_id);
          // Better Auth carries referenceId from this code through every
          // refresh rotation. Never rebind an old lineage to a new consent.
          return { data: { value: JSON.stringify({ ...value, referenceId: consent?.id ?? "" }) } };
        },
      },
    },
  };

  const sessionCache = config.sessionCache;
  let storeInstanceId: Promise<string> | undefined;
  const cacheKey = async (key: string): Promise<string> => {
    storeInstanceId ??= readStoreInstanceId(config.driver)
      .catch((error) => { storeInstanceId = undefined; throw error; });
    return `better-auth:${await storeInstanceId}:${key}`;
  };
  const secondaryStorage = sessionCache ? {
    get: async (key: string) => key.startsWith("verification:")
      ? Promise.resolve(null)
      : sessionCache.get(await cacheKey(key)),
    set: async (key: string, value: string, ttl?: number) => key.startsWith("verification:")
      ? Promise.resolve()
      : sessionCache.set(
          await cacheKey(key),
          value,
          ttl ? Math.max(60, Math.ceil(ttl)) : undefined,
        ),
    delete: async (key: string) => key.startsWith("verification:")
      ? Promise.resolve()
      : sessionCache.delete(await cacheKey(key)),
    // Verification and rate limiting stay in the primary store / memory below. Fail loudly if
    // Better Auth starts routing either atomic operation through this adapter.
    getAndDelete: async () => { throw new Error("Better Auth KV getAndDelete is disabled"); },
    increment: async () => { throw new Error("Better Auth KV increment is disabled"); },
  } : undefined;

  return betterAuth({
    database: config.database,
    secondaryStorage,
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: normalizeAuthBasePath(config.basePath),
    onAPIError: { errorURL: normalizeAuthErrorURL(config.errorURL, config.baseURL) },
    socialProviders,
    ...(config.accountLinking
      ? { account: { accountLinking: config.accountLinking } }
      : {}),
    user: userConfig,
    rateLimit,
    trustedOrigins,
    advanced: advancedConfig,
    plugins,
    databaseHooks,
  });
}

