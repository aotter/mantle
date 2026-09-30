/** Sign-in methods to Better Auth options: providers, email plugins, the bootstrap owner rule, trusted origins, paths and cookies. */
import { oauthProvider } from "@better-auth/oauth-provider";
import {
type BetterAuthOptions
} from "better-auth";
import { splitSetCookieHeader } from "better-auth/cookies";
import {
emailOTP,
magicLink,
type GenericOAuthConfig
} from "better-auth/plugins";
import type { SocialProviders } from "better-auth/social-providers";
import { signInCodeEmail,signInLinkEmail } from "./emailTemplates.js";

export type { OAuthProviderExtension } from "@better-auth/oauth-provider";
export type { AuthUserInfo,InviteUserResult,ListMembersArgs,MemberListResult,MemberUserInfo,StaffUserInfo } from "../admin/identity.js";

import { AuthMethodConfig,BootstrapOwnerRule,OAuthProviderConfig,SocialProviderId } from "./types.js";
export function normalizeAuthBasePath(basePath: string | undefined): string {
  if (basePath === undefined) return "/api/auth";
  const trimmed = basePath.trim();
  if (trimmed === "") return "/api/auth";
  if (!trimmed.startsWith("/")) {
    throw new Error("createMantleAuth: basePath must start with '/'.");
  }
  if (trimmed === "/") {
    throw new Error("createMantleAuth: basePath must not be '/'.");
  }
  if (trimmed.endsWith("/")) {
    return trimmed.replace(/\/+$/, "");
  }
  return trimmed;
}

/** @internal exported for unit tests; not part of the public API. */
export function resolveClientIpHeaders(
  headers: ReadonlyArray<string> | undefined,
): readonly string[] {
  const resolved = (headers ?? [])
    .map((header) => header.trim())
    .filter((header) => header.length > 0);
  if (resolved.length === 0) {
    throw new Error(
      "createMantleAuth: ipAddressHeaders is required and must name at least one host-trusted ingress header. " +
        "Do not default to client-controlled X-Forwarded-For. Host adapters must pass the header(s) their ingress overwrites.",
    );
  }
  return resolved;
}

export function normalizeAuthErrorURL(errorURL: string | undefined, baseURL: string): string {
  const base = new URL(baseURL);
  const resolved = new URL(errorURL ?? "/", base);
  if (resolved.origin !== base.origin) {
    throw new Error("createMantleAuth: errorURL must be same-origin with baseURL.");
  }
  return `${resolved.pathname}${resolved.search}`;
}

export function normalizeAuthResponseCookies(response: Response): Response {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return response;
  const values =
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [setCookie];
  const cookies = values.flatMap(splitSetCookieHeader);
  if (cookies.length < 2) return response;

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


type GithubSocialOptions = Exclude<
  NonNullable<SocialProviders["github"]>,
  () => unknown
>;

function withGithubLogin(options: NonNullable<SocialProviders["github"]>) {
  return typeof options === "function"
    ? async () => withGithubLoginMapper(await options())
    : withGithubLoginMapper(options);
}

function withGithubLoginMapper(options: GithubSocialOptions): GithubSocialOptions {
  const developerMapper = options.mapProfileToUser;
  return {
    ...options,
    mapProfileToUser: async (profile) => ({
      ...(developerMapper ? await developerMapper(profile) : {}),
      githubLogin: profile.login,
    }),
  };
}

export function buildSocialProviders(
  methods: ReadonlyArray<AuthMethodConfig>,
): BetterAuthOptions["socialProviders"] {
  const out: Partial<Record<SocialProviderId, unknown>> = {};
  // Duplicate-provider guard: catch the case where two `social`
  // methods declare the same `provider` id. Better Auth would
  // silently keep the latter (Record overwrite); for SDK adopters —
  // and especially for the upcoming feature-overlay path where a
  // feature can contribute auth methods into the same starter's
  // `methods[]` array — that silent overwrite is a footgun. Throw at
  // construction with a clear message so the conflict surfaces
  // before the first sign-in.
  const seenProviders = new Set<SocialProviderId>();
  for (const method of methods) {
    if (method.kind !== "social") continue;
    if (seenProviders.has(method.provider)) {
      throw new Error(
        `createMantleAuth: social provider '${method.provider}' is registered more than once; ` +
          `each provider can have only one methods[] entry. Remove the redundant entry or pick a different provider.`,
      );
    }
    seenProviders.add(method.provider);
    out[method.provider] = method.provider === "github"
      ? withGithubLogin(method.options)
      : method.options;
  }
  return out as SocialProviders;
}

export function buildGenericOAuthProviders(
  methods: ReadonlyArray<AuthMethodConfig>,
): GenericOAuthConfig[] {
  const seenProviderIds = new Set<string>();
  const socialProviderIds: ReadonlySet<string> = new Set(
    methods.flatMap((method) =>
      method.kind === "social" ? [method.provider] : [],
    ),
  );
  const out: ReturnType<typeof buildGenericOAuthProviders> = [];
  for (const method of methods) {
    if (method.kind !== "oauth") continue;
    if (socialProviderIds.has(method.options.providerId)) {
      throw new Error(`createMantleAuth: OAuth providerId '${method.options.providerId}' conflicts with a registered social provider id. Provider ids must be unique across methods[].`);
    }
    if (seenProviderIds.has(method.options.providerId)) {
      throw new Error(
        `createMantleAuth: OAuth provider '${method.options.providerId}' is registered more than once; ` +
          `each providerId can have only one methods[] entry.`,
      );
    }
    seenProviderIds.add(method.options.providerId);
    if (!method.options.discoveryUrl && !(method.options.authorizationUrl && method.options.tokenUrl)) {
      throw new Error(`createMantleAuth: OAuth provider '${method.options.providerId}' needs either discoveryUrl or both authorizationUrl and tokenUrl.`);
    }
    out.push(method.options);
  }
  return out;
}

/**
 * First tag off `Accept-Language`, quality values ignored. Locale
 * contract lives in `EmailSender.ts`.
 */
export function pickLocale(req: Request | undefined, fallback: string): string {
  const header = req?.headers.get("accept-language");
  if (!header) return fallback;
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  return first && first.length > 0 ? first : fallback;
}

const MAGIC_LINK_DEFAULT_EXPIRES_SECONDS = 900;

export function buildMagicLinkPlugin(method: Extract<AuthMethodConfig, { kind: "magic-link" }>) {
  const fallback = method.fallbackLocale ?? "en";
  return magicLink({
    storeToken: "hashed",
    expiresIn: MAGIC_LINK_DEFAULT_EXPIRES_SECONDS,
    ...method.options,
    // Returned synchronously — same fire-and-forget contract as
    // email-otp via `advanced.backgroundTasks.handler`. The body
    // carries the click-URL; SDK doesn't ship a template, the
    // sender can render plain text or richer HTML.
    sendMagicLink: (data, ctx) => {
      const locale = pickLocale(ctx?.request, fallback);
      return method.sender.send({
        to: data.email,
        ...signInLinkEmail(data.url),
        locale,
        category: "auth.magic-link.sign-in",
      });
    },
  });
}

export function buildEmailOTPPlugin(
  method: Extract<AuthMethodConfig, { kind: "email-otp" }>,
  secret: string,
) {
  const fallback = method.fallbackLocale ?? "en";
  return emailOTP({
    storeOTP: { hash: (otp) => hashEmailOtp(secret, otp) },
    ...method.options,
    // Return synchronously — the promise is fire-and-forget via the
    // `advanced.backgroundTasks.handler` we wire in `buildAuth`. For
    // `email-verification` / `forget-password` types Better Auth only
    // calls this when the user exists, so awaiting would leak account
    // existence through response latency. See Better Auth's own
    // sendVerificationOTP docstring + reviewer finding in PR #161.
    sendVerificationOTP: (data, ctx) => {
      const locale = pickLocale(ctx?.request, fallback);
      return method.sender.send({
        to: data.email,
        ...signInCodeEmail(data.otp),
        locale,
        category: `auth.email-otp.${data.type}`,
      });
    },
  });
}

const EMAIL_AUTH_PLUGIN_IDS = new Set(["email-otp", "magic-link"]);

/** Exported for the adapters' unit tests; not part of the supported API. */
export function hasEmailAuthSurface(
  methods: ReadonlyArray<AuthMethodConfig>,
  plugins: ReadonlyArray<{ readonly id: string }> = [],
): boolean {
  return methods.some((method) => method.kind === "email-otp" || method.kind === "magic-link")
    || plugins.some((plugin) => EMAIL_AUTH_PLUGIN_IDS.has(plugin.id));
}

/** HMAC-SHA-256(secret, otp) as unpadded base64url. Exported for tests only. */
export async function hashEmailOtp(secret: string, otp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(otp)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/**
 * Cross-check bootstrap rule against registered methods. Catches the
 * silent-no-op case where the rule's discriminator can never match
 * any signal a registered method actually produces — e.g.
 * `match: "github-login"` with no `github` provider registered. Throws
 * at construction so vibe-coders see the mistake before the first
 * sign-in attempt.
 *
 * `match: "email"` is permissive — every Better Auth method that
 * creates a user populates `email`, including GitHub (via the
 * upstream profile). No registration constraint to enforce.
 */
export function validateBootstrap(
  rule: BootstrapOwnerRule,
  methods: ReadonlyArray<AuthMethodConfig>,
): void {
  if (rule.match === "github-login") {
    const hasGithub = methods.some(
      (method) =>
        (method.kind === "social" && method.provider === "github") ||
        (method.kind === "oauth" && method.options.providerId === "github"),
    );
    if (!hasGithub) {
      throw new Error(
        "createMantleAuth: bootstrapOwner.match='github-login' but no GitHub provider is registered. " +
          "Register social GitHub or a trusted OAuth providerId='github', or switch to email matching.",
      );
    }
  }
}

export function shouldPromoteToOwner(
  rule: BootstrapOwnerRule,
  user: { readonly email?: string | null; readonly githubLogin?: string | null },
): boolean {
  const target = rule.value.trim().toLowerCase();
  switch (rule.match) {
    case "github-login":
      return !!user.githubLogin && user.githubLogin.toLowerCase() === target;
    case "email":
      return !!user.email && user.email.toLowerCase() === target;
  }
}

export type AuthHookContext = {
  readonly path: string;
  readonly params?: Readonly<Record<string, unknown>>;
} | null;

/** Keep provider-owned GitHub logins off user-controlled auth paths. */
export function guardGithubLoginProfile(
  user: Readonly<Record<string, unknown>>,
  context: AuthHookContext,
  methods: ReadonlyArray<AuthMethodConfig>,
): { readonly data: { readonly githubLogin: null } } | undefined {
  if (!("githubLogin" in user)) return undefined;
  const providerId = context?.path === "/callback/:id" ? context.params?.id : null;
  const trusted = typeof providerId === "string" && methods.some((method) =>
    method.kind === "social"
      ? context?.path === "/callback/:id" && method.provider === "github" && providerId === "github"
      : method.kind === "oauth" &&
        context?.path === "/callback/:id" &&
        method.options.providerId === providerId &&
        Boolean(method.options.mapProfileToUser),
  );
  return trusted ? undefined : { data: { githubLogin: null } };
}

/**
 * Find the at-most-one method of `kind`. Throws when adopters register
 * the same kind twice — Better Auth's plugin layer accepts duplicates
 * silently, which would mask the intent at boot. One helper covers
 * every singleton-shaped method (email-otp, magic-link, future ones).
 */
export function pickSingleton<K extends AuthMethodConfig["kind"]>(
  methods: ReadonlyArray<AuthMethodConfig>,
  kind: K,
): Extract<AuthMethodConfig, { kind: K }> | undefined {
  const matches = methods.filter(
    (m): m is Extract<AuthMethodConfig, { kind: K }> => m.kind === kind,
  );
  if (matches.length > 1) {
    throw new Error(
      `createMantleAuth: more than one \`${kind}\` method registered. Combine into one.`,
    );
  }
  return matches[0];
}

/**
 * Origins each registered social provider needs in
 * `trustedOrigins`. Adding a provider that demands an extra
 * `trustedOrigins` entry = adding a row here. Apple is the only one
 * in 1.6.9 that hard-requires this; if Better Auth ever drops the
 * requirement, the entry stays harmless (Better Auth dedupes).
 */
const SOCIAL_PROVIDER_TRUSTED_ORIGINS: Readonly<
  Partial<Record<SocialProviderId, ReadonlyArray<string>>>
> = {
  apple: ["https://appleid.apple.com"],
};

export function buildTrustedOriginsFor(
  methods: ReadonlyArray<AuthMethodConfig>,
  configured: ReadonlyArray<string> = [],
): string[] {
  const origins = methods.flatMap((m) =>
    m.kind === "social" ? SOCIAL_PROVIDER_TRUSTED_ORIGINS[m.provider] ?? [] : [],
  );
  return [...new Set([...origins, ...configured])];
}

/**
 * Apple uses `response_mode=form_post` — Apple POSTs cross-site to
 * our callback. The OAuth state cookie must have `sameSite: "none"`
 * (and `secure: true`, which browsers require alongside) or the
 * cookie won't ride the POST and Better Auth raises a state mismatch.
 * Other providers don't need this. We only auto-set when Apple is
 * registered AND the adopter hasn't already specified
 * `defaultCookieAttributes.sameSite` themselves.
 */
export function methodsRequireSameSiteNone(
  methods: ReadonlyArray<AuthMethodConfig>,
): boolean {
  return methods.some((m) => m.kind === "social" && m.provider === "apple");
}

export function buildOAuthProviderOptions(
  config: OAuthProviderConfig,
): Parameters<typeof oauthProvider>[0] {
  return {
    loginPage: config.loginPage,
    consentPage: config.consentPage,
    ...(config.scopes ? { scopes: [...config.scopes] } : {}),
    ...(config.resources
      ? { resources: [...config.resources] }
      : {}),
    ...(config.clientRegistrationDefaultResources
      ? { clientRegistrationDefaultResources: [...config.clientRegistrationDefaultResources] }
      : {}),
    ...(config.mcpResource
      ? {
          clientRegistrationClientSecretExpiration: "90d",
          allowPublicClientPrelogin: true,
        }
      : {}),
    ...(config.allowDynamicClientRegistration !== undefined
      ? { allowDynamicClientRegistration: config.allowDynamicClientRegistration }
      : {}),
    ...(config.allowUnauthenticatedClientRegistration !== undefined
      ? {
          allowUnauthenticatedClientRegistration:
            config.allowUnauthenticatedClientRegistration,
        }
      : {}),
    ...(config.clientRegistrationDefaultScopes
      ? {
          clientRegistrationDefaultScopes: [
            ...config.clientRegistrationDefaultScopes,
          ],
        }
      : {}),
    ...(config.clientRegistrationAllowedScopes
      ? {
          clientRegistrationAllowedScopes: [
            ...config.clientRegistrationAllowedScopes,
          ],
        }
      : {}),
    ...(config.cachedTrustedClients
      ? { cachedTrustedClients: new Set(config.cachedTrustedClients) }
      : {}),
    ...(config.clientPrivileges
      ? { clientPrivileges: config.clientPrivileges }
      : {}),
  };
}

