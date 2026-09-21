import { AsyncLocalStorage } from "node:async_hooks";
import {
  betterAuth,
  type BetterAuthOptions,
  type BetterAuthPlugin,
} from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
  type DpopReplayStore,
} from "better-auth/oauth2";
import type { SocialProviders } from "better-auth/social-providers";
import {
  admin,
  emailOTP,
  jwt,
  magicLink,
  type EmailOTPOptions,
  type GenericOAuthConfig,
  type MagicLinkOptions,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { splitSetCookieHeader } from "better-auth/cookies";
import { oauthProvider, type Scope } from "@better-auth/oauth-provider";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import {
  decodeMemberCursor,
  encodeMemberCursor,
  type OAuthConsentInfo,
  type OAuthConsentRequest,
} from "@aotter/mantle-admin";
import type { DatabaseDriver, EmailSender } from "@aotter/mantle-runtime";
import { signInCodeEmail, signInLinkEmail, staffInvitationEmail } from "./emailTemplates.js";
import { STAFF_ROLES, type StaffRole } from "@aotter/mantle-spec";

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

interface BetterAuthGlobal {
  version: string;
  epoch: number;
  context: Record<string, unknown>;
}

export { decodeMemberCursor, encodeMemberCursor };
export type { OAuthConsentInfo, OAuthConsentRequest } from "@aotter/mantle-admin";
export { STAFF_ROLES, type StaffRole };
/**
 * Set lookup for "is this role string a staff role?" — handlers/MCP
 * gating reach for this every request, so the Set form is worth the
 * one-time allocation over `STAFF_ROLES.includes(x)`.
 */
export const STAFF_ROLE_SET: ReadonlySet<string> = new Set(STAFF_ROLES);

/**
 * Provider id for the `kind: "social"` method — Better Auth's own
 * `socialProviders` block keys. The config flows through to Better
 * Auth as-is; no per-provider wiring in this adapter (beyond the
 * github `mapProfileToUser` shim).
 */
export type SocialProviderId = keyof SocialProviders;

type SocialAuthMethodConfig = {
  [Provider in SocialProviderId]: {
    readonly kind: "social";
    readonly provider: Provider;
    /** Native Better Auth options for this provider, including async factories. */
    readonly options: NonNullable<SocialProviders[Provider]>;
  };
}[SocialProviderId];

/**
 * Auth method config (discriminated union). Each `kind` is one auth
 * surface adopters can opt into; adding a new method = adding a new
 * union case here, not a new top-level key on `CreateMantleAuthOptions` —
 * per ADR-0014.
 *
 * `kind: "social"` is the OAuth-based bucket — `provider` discriminates
 * the upstream IDP. We use one case rather than one-per-provider so
 * adding (e.g.) Apple doesn't churn Mantle-owned fields; Better Auth's
 * provider-specific options remain natively typed under `options`.
 */
export type AuthMethodConfig =
  | SocialAuthMethodConfig
  | {
      readonly kind: "oauth";
      /** Human label surfaced by `/api/auth/methods` so the admin SPA
       *  can render "Continue with Mantle Platform" without knowing
       *  product-specific provider ids. */
      readonly displayName?: string;
      /** Native Better Auth generic OAuth configuration. */
      readonly options: GenericOAuthConfig;
    }
  | {
      readonly kind: "email-otp";
      /** Transactional-email sender. SDK never owns body templates;
       *  the locale is passed through so the sender can branch. */
      readonly sender: EmailSender;
      /** Native Better Auth options. Mantle owns the sender callback and
       *  defaults OTP storage to a keyed HMAC of the code. */
      readonly options?: Omit<EmailOTPOptions, "sendVerificationOTP">;
      /** Fallback locale when the request carries no Accept-Language —
       *  typically the site's canonical locale. BCP 47. Defaults to "en". */
      readonly fallbackLocale?: string;
    }
  | {
      readonly kind: "magic-link";
      /** Transactional-email sender. The email body carries a single
       *  clickable URL; Better Auth verifies the token when the user
       *  lands on it. */
      readonly sender: EmailSender;
      /** Native Better Auth options. Mantle owns the sender callback and defaults storage to hashed. */
      readonly options?: Omit<MagicLinkOptions, "sendMagicLink">;
      /** Fallback locale when the request carries no Accept-Language. */
      readonly fallbackLocale?: string;
    };

/**
 * First-staff promotion rule. Decoupled from `methods[]` so switching
 * the bootstrap signal (e.g. `github-login` → `email`) doesn't touch
 * any method's options.
 *
 * Promotion fires on `user.create.after`, which Better Auth dispatches
 * **only on first user creation**. If the operator signs in via one
 * method (say GitHub) before the rule can match (say `match: "email"`
 * with a non-GitHub email), the user row is created and a later
 * sign-in via a different method on the SAME email reuses that row —
 * `create.after` does not re-fire and the owner role is never
 * assigned. Match key first; the linked second method inherits the
 * role via the shared `user.id`.
 *
 * `match: "github-login"` is also brittle when multiple social
 * methods are registered. Only the `github` provider's
 * `mapProfileToUser` shim populates `user.githubLogin`; if the
 * operator's first sign-in is via Google or another non-GitHub
 * social, `githubLogin` is null and the rule silently no-ops. For
 * mixed-social setups prefer `match: "email"`.
 */
export type BootstrapOwnerRule =
  | { readonly match: "github-login"; readonly value: string }
  | { readonly match: "email"; readonly value: string };

export interface CrossSubDomainCookiesConfig {
  readonly enabled: boolean;
  readonly domain?: string;
}

export interface OAuthProviderConfig {
  /** Provider scopes. Include `openid` to expose a real OIDC server. */
  readonly scopes?: ReadonlyArray<Scope>;
  /** Better Auth OAuth provider login page. Usually `/admin/sign-in`
   *  or a platform owner sign-in route. */
  readonly loginPage: string;
  /** Page that calls `/oauth2/consent` after owner approval. */
  readonly consentPage: string;
  readonly allowDynamicClientRegistration?: boolean;
  readonly allowUnauthenticatedClientRegistration?: boolean;
  readonly clientRegistrationDefaultScopes?: ReadonlyArray<Scope>;
  readonly clientRegistrationAllowedScopes?: ReadonlyArray<Scope>;
  /** MCP resources still require a persisted user consent; do not bypass it. */
  readonly cachedTrustedClients?: ReadonlySet<string>;
  /** Protected resources this authorization server may issue tokens for. */
  readonly resources?: ReadonlyArray<string>;
  /** Resources linked to newly registered public clients. Does not bypass consent. */
  readonly clientRegistrationDefaultResources?: ReadonlyArray<string>;
  /** Turn this provider into the MCP authorization server for one canonical
   *  resource. Cloudflare deployments must enable
   *  `global_fetch_strictly_public` for CIMD fetches. */
  readonly mcpResource?: string;
  readonly clientPrivileges?: (context: {
    readonly headers: Headers;
    readonly action:
      | "create"
      | "read"
      | "update"
      | "delete"
      | "list"
      | "rotate"
      | "configure-client-credentials-scopes";
    readonly user?: { readonly id: string; readonly email: string } & Record<string, unknown>;
    readonly session?: { readonly id: string; readonly userId: string } & Record<
      string,
      unknown
    >;
  }) => boolean | undefined | Promise<boolean | undefined>;
}

export interface RegisterOAuthClientInput {
  /** Current owner/admin request headers. Better Auth enforces its
   *  clientPrivileges hook against this session before persistence. */
  readonly requestHeaders: HeadersInit;
  readonly redirectUris: ReadonlyArray<string>;
  readonly scope?: ReadonlyArray<string>;
  readonly clientName?: string;
  readonly clientUri?: string;
  readonly logoUri?: string;
  readonly contacts?: ReadonlyArray<string>;
  readonly tosUri?: string;
  readonly policyUri?: string;
  readonly postLogoutRedirectUris?: ReadonlyArray<string>;
  readonly tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  readonly grantTypes?: ReadonlyArray<
    "authorization_code" | "client_credentials" | "refresh_token"
  >;
  readonly responseTypes?: ReadonlyArray<"code">;
  readonly applicationType?: "web" | "native";
  /** Not suitable for MCP clients: MCP access requires a persisted user consent. */
  readonly skipConsent?: boolean;
  readonly enableEndSession?: boolean;
  readonly requirePKCE?: boolean;
  readonly subjectType?: "public" | "pairwise";
  readonly metadata?: Record<string, unknown>;
}

export interface RegisteredOAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUris: readonly string[];
  readonly scope?: readonly string[];
  readonly clientName?: string;
  readonly clientUri?: string;
  readonly tokenEndpointAuthMethod?: string;
  readonly applicationType?: "web" | "native";
}

/**
 * Host-supplied cache for Better Auth session reads. Keys and TTL policy are
 * owned by this package; the host only stores what it is given. Implementations
 * are typically eventually consistent, so verification codes and rate limits
 * never use it.
 */
export interface AuthSessionCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CreateMantleAuthOptions {
  /**
   * Better Auth's database handle for the **same** store as `driver`.
   * Auth SQL is SQLite-shaped and expects JSON1; a non-SQLite
   * `DatabaseDriver` is not a supported auth backend in v0.1. The two
   * handles must wrap one underlying store — splitting them splits
   * schema migration from Better Auth's own reads.
   */
  readonly database: NonNullable<BetterAuthOptions["database"]>;
  /** Mantle's port over that same store. Carries this package's own SQL and the
   * Better Auth schema migration. */
  readonly driver: DatabaseDriver;
  readonly sessionCache?: AuthSessionCache;
  readonly baseURL: string;
  /** Better Auth route prefix. Defaults to `/api/auth`. Set this when
   *  multiple auth instances live in one Worker, e.g. hosted platform
   *  provider + site staff auth + launch GitHub auth. */
  readonly basePath?: string;
  /** Same-origin destination for auth failures. Defaults to `/`. */
  readonly errorURL?: string;
  readonly secret: string;
  /** Registered auth methods. Boot fails fast when this and `plugins` are both empty. */
  readonly methods: ReadonlyArray<AuthMethodConfig>;
  /** Native Better Auth plugins for flows whose callbacks and UI are fully adopter-owned. */
  readonly plugins?: ReadonlyArray<BetterAuthPlugin>;
  /** Sends an English notification after Admin successfully assigns a staff role. */
  readonly staffInvitationSender?: EmailSender;
  /** First-user-becomes-owner rule. Without it, the `owner` role must
   *  be assigned manually in the auth store. */
  readonly bootstrapOwner?: BootstrapOwnerRule;
  /** Better Auth's always-enabled rate limit. Email methods default to
   *  10/minute, others to 100/minute; plugin-specific limits still apply. */
  readonly rateLimit?: { readonly window: number; readonly max: number };
  /** Additional Better Auth trusted origins. SDK still injects
   *  provider-required origins such as Apple automatically. */
  readonly trustedOrigins?: ReadonlyArray<string>;
  /** Forwarded to Better Auth's `advanced.crossSubDomainCookies`.
   *  Use only for trusted first-party app families. */
  readonly crossSubDomainCookies?: CrossSubDomainCookiesConfig;
  /** Forwarded to Better Auth's `advanced.cookiePrefix`. Set this
   *  when multiple Better Auth apps share a parent cookie domain. */
  readonly cookiePrefix?: string;
  /** HTTPS-only __Host- cookies for isolation from sibling tenant domains.
   * Incompatible with crossSubDomainCookies.enabled. Defaults to false. */
  readonly hostOnlyCookies?: boolean;
  /** Turn this Better Auth instance into an OAuth/OIDC provider.
   *  Consumer sites should use `methods: [{ kind: "oauth", ... }]`
   *  against its discovery document. */
  readonly oauthProvider?: OAuthProviderConfig;
  /**
   * Host-trusted ingress headers used as Better Auth's rate-limit identity.
   * Required and fail-closed: empty or missing refuses to boot. Pass only
   * headers the host overwrites at the edge. Never default to
   * client-controlled `X-Forwarded-For`. Cloudflare `createAuth` supplies
   * `cf-connecting-ip`; Bun and Vercel hosts must pass their own header(s).
   */
  readonly ipAddressHeaders: ReadonlyArray<string>;
}

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

function normalizeAuthErrorURL(errorURL: string | undefined, baseURL: string): string {
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
      throw new Error(
        `createMantleAuth: OAuth providerId '${method.options.providerId}' conflicts with a registered social provider id. Provider ids must be unique across methods[].`,
      );
    }
    if (seenProviderIds.has(method.options.providerId)) {
      throw new Error(
        `createMantleAuth: OAuth provider '${method.options.providerId}' is registered more than once; ` +
          `each providerId can have only one methods[] entry.`,
      );
    }
    seenProviderIds.add(method.options.providerId);
    if (!method.options.discoveryUrl && !(method.options.authorizationUrl && method.options.tokenUrl)) {
      throw new Error(
        `createMantleAuth: OAuth provider '${method.options.providerId}' needs either discoveryUrl or both authorizationUrl and tokenUrl.`,
      );
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

function buildMagicLinkPlugin(method: Extract<AuthMethodConfig, { kind: "magic-link" }>) {
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

function buildEmailOTPPlugin(
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

type AuthHookContext = {
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
function pickSingleton<K extends AuthMethodConfig["kind"]>(
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
function methodsRequireSameSiteNone(
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

function buildAuth(config: CreateMantleAuthOptions) {
  const ipAddressHeaders = resolveClientIpHeaders(config.ipAddressHeaders);
  if (config.hostOnlyCookies && (new URL(config.baseURL).protocol !== "https:" || config.crossSubDomainCookies?.enabled)) {
    throw new Error("createMantleAuth: hostOnlyCookies requires HTTPS and cannot share cookies across subdomains.");
  }
  if (config.methods.length === 0 && !config.plugins?.length) {
    throw new Error(
      "createMantleAuth: methods[] is empty — register an AuthMethodConfig or native Better Auth plugin so staff can sign in.",
    );
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
                extensions: [{
                  claims: {
                    accessToken: ({ referenceId }) => ({ mantle_consent_id: referenceId ?? null }),
                  },
                }],
              })
            : oauthProvider(providerOptions),
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
      throw new Error(
        `createMantleAuth: Better Auth plugin '${plugin.id}' is registered more than once. Remove the duplicate plugin.`,
      );
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
        p.catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[better-auth backgroundTask]", err);
        });
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
    const result = await config.driver
      .prepare(
        `UPDATE user SET role = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user WHERE role IN (${placeholders}))`,
      )
      .bind("owner", u.id, ...STAFF_ROLES)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      // Operator-visible signal that the rule matched but a prior
      // staff user already exists — otherwise the silent no-op makes a
      // misconfigured bootstrap rule indistinguishable from a working
      // first-promotion.
      console.warn(
        `[bootstrap] user ${u.id} matched bootstrapOwner rule but promotion was blocked — a staff user already exists.`,
      );
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
          const consent = await config.driver
            .prepare("SELECT id FROM oauthConsent WHERE userId = ? AND clientId = ? LIMIT 1")
            .bind(value.userId, value.query.client_id)
            .first<{ id: string }>();
          // Better Auth carries referenceId from this code through every
          // refresh rotation. Never rebind an old lineage to a new consent.
          return { data: { value: JSON.stringify({ ...value, referenceId: consent?.id ?? "" }) } };
        },
      },
    },
  };

  const sessionCache = config.sessionCache;
  const secondaryStorage = sessionCache ? {
    get: (key: string) => key.startsWith("verification:")
      ? Promise.resolve(null)
      : sessionCache.get(`better-auth:${key}`),
    set: (key: string, value: string, ttl?: number) => key.startsWith("verification:")
      ? Promise.resolve()
      : sessionCache.set(
          `better-auth:${key}`,
          value,
          ttl ? Math.max(60, Math.ceil(ttl)) : undefined,
        ),
    delete: (key: string) => key.startsWith("verification:")
      ? Promise.resolve()
      : sessionCache.delete(`better-auth:${key}`),
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
    user: userConfig,
    rateLimit,
    trustedOrigins,
    advanced: advancedConfig,
    plugins,
    databaseHooks,
  });
}

/**
 * Public-facing method descriptor exposed via `Auth.methods` and the
 * `GET /api/auth/methods` endpoint. The `social` kind carries the
 * upstream `provider` so the admin SPA can render a per-provider
 * button (label + future brand icon). Secrets, senders, and per-
 * provider extras stay private.
 */
export type AuthMethodInfo =
  | { readonly kind: "email-otp" }
  | { readonly kind: "magic-link" }
  | { readonly kind: "social"; readonly provider: SocialProviderId }
  | {
      readonly kind: "oauth";
      readonly providerId: string;
      readonly displayName?: string;
    };

/**
 * Linked-account row as exposed to consumers. Mirrors the BA `account`
 * table's identity columns; OAuth tokens and other secret-shaped
 * columns are intentionally excluded — callers should never need them
 * to render a "signed in via <provider>" list.
 */
export interface LinkedAccountInfo {
  readonly id: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * User row as exposed to the staff-management surface. Mirrors the BA
 * `user` table's identity columns; password hashes, ban metadata, and
 * other secret-shaped columns are intentionally excluded.
 *
 * `emailVerified: false` + no linked account identifies a pending
 * invitation; invited rows already carry their requested staff role.
 */
export interface StaffUserInfo {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string | null;
  readonly githubLogin: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}

export type MemberUserInfo = Pick<
  StaffUserInfo,
  "id" | "email" | "name" | "emailVerified" | "createdAt"
>;

export interface MemberListResult {
  readonly items: readonly MemberUserInfo[];
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
}

export interface ListMembersArgs {
  readonly search?: string;
  readonly cursor?: string;
  readonly cursorDirection?: "forward" | "backward";
  readonly limit: number;
}

/** Stable, secret-free user projection for consumer-owned services. */
export interface AuthUserInfo extends StaffUserInfo {
  readonly image: string | null;
}

/** Result of `inviteUser`. `exists` carries the prior row's id so the
 *  caller can point the operator at the existing user instead of
 *  surfacing a bare failure. */
export type InviteUserResult =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "exists"; readonly id: string };

export interface ProviderAccessToken {
  readonly accessToken: string;
  readonly accessTokenExpiresAt?: Date;
  readonly scopes: readonly string[];
}

export type OAuthAccessTokenVerification =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly clientId: string | null;
      readonly credentialId: string | null;
      readonly scopes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly reason:
        | "invalid-token"
        | "invalid-dpop-proof"
        | "insufficient-scope";
      readonly missingScopes?: readonly string[];
    };

// Better Auth's full inferred type pulls plugin internals
// (`AdminOptions`) that aren't re-exported, so emitting a .d.ts that
// names that type fails (TS4058). The structural facade keeps the
// public surface stable.
export interface MantleAuth {
  readonly basePath: string;
  /** Better Auth's per-isolate context; Workers must anchor this before responding. */
  readonly ready?: Promise<void>;
  /** Canonical MCP protected resource when this Auth owns one. */
  readonly mcpResource?: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (request: Request) => Promise<{
    session: { id: string; userId: string; expiresAt: Date };
    user: {
      id: string;
      email: string;
      name: string;
      image?: string | null;
      role?: string | null;
      /** The role came from the same uncached database read as this session. */
      roleCurrent?: true;
      githubLogin?: string | null;
    };
  } | null>;
  /** Authoritative `user.role` lookup. Protected Admin, MCP, preview,
   *  and HTTP Trigger calls use this on every request so custom Auth
   *  session snapshots cannot retain revoked staff access. */
  readonly getUserRole: (userId: string) => Promise<string | null>;
  /** Read one Better Auth-owned user without coupling consumers to its SQL schema.
   *  Optional so existing custom Auth implementations remain source-compatible. */
  readonly getUser?: (userId: string) => Promise<AuthUserInfo | null>;
  /** Retrieve (and, when expired, refresh) a linked provider token for
   *  the user identified by the current local session request. Refresh
   *  tokens and account rows are never returned. */
  readonly getProviderAccessToken: (
    request: Request,
    providerId: string,
  ) => Promise<ProviderAccessToken>;
  /** Verify a JWT access token against this Auth instance's issuer and
   *  JWKS. Passing a Request also enforces DPoP proof binding and persistent
   *  replay protection. Opaque tokens and remote introspection are not
   *  supported. */
  readonly verifyOAuthAccessToken: (
    tokenOrRequest: string | Request,
    options: {
      readonly audience: string;
      readonly scopes?: readonly string[];
    },
  ) => Promise<OAuthAccessTokenVerification>;
  /** Secret-free client projection for the current consent redirect. */
  readonly getOAuthConsentRequest: (
    request: Request,
  ) => Promise<OAuthConsentRequest | null>;
  /** Submit the original signed query and return the validated client redirect. */
  readonly completeOAuthConsent: (
    request: Request,
    accept: boolean,
  ) => Promise<string>;
  /** User-facing OAuth grants. Optional so custom Auth facades stay compatible. */
  readonly listOAuthConsents?: (
    userId: string,
  ) => Promise<readonly OAuthConsentInfo[]>;
  /** Revoke every token and consent row for one user/client grant. */
  readonly revokeOAuthConsent?: (
    userId: string,
    consentId: string,
  ) => Promise<boolean>;
  /** Methods the consumer registered, in declaration order. The admin
   *  SPA renders sign-in sections per this list. Secrets, senders, and
   *  per-provider extras are intentionally excluded — UI doesn't need
   *  them. `social` methods carry the upstream `provider` id for
   *  per-provider rendering. */
  readonly methods: ReadonlyArray<AuthMethodInfo>;
  /** List a user's linked social/credential accounts. Ordered by
   *  `createdAt` ascending so the UI can render "linked since" in a
   *  stable order across reloads. Read-only — uses the underlying D1
   *  binding directly, no Better Auth API call. */
  readonly listLinkedAccounts: (
    userId: string,
  ) => Promise<readonly LinkedAccountInfo[]>;
  /** Unlink a single account by `(userId, providerId)`. Returns true if
   *  a row was deleted, false if no matching account existed. Does NOT
   *  guard against unlinking the user's only sign-in method — the
   *  caller knows their auth method mix and decides whether the
   *  resulting state is sign-in-able. The runtime can't, because
   *  email-OTP / magic-link sign-ins do not write to the `account`
   *  table at all, so "rows left" is not a reliable indicator. */
  readonly unlinkAccount: (
    userId: string,
    providerId: string,
  ) => Promise<boolean>;
  /** List only users with a staff role, ordered by `createdAt`
   *  ascending. End-user identities stay outside the team-management
   *  surface. Owner-only enforcement is the mount layer's job. */
  readonly listUsers: () => Promise<readonly StaffUserInfo[]>;
  /** List non-staff identities for the member-management surface. */
  readonly listMembers: (args: ListMembersArgs) => Promise<MemberListResult>;
  /** Assign or clear a user's staff role. `null` revokes staff access
   *  (the row keeps existing — the user can still sign in, but every
   *  staff-gated surface 403s). Returns false when no row matched.
   *  Throws on a non-staff role string — programmer error, not an
   *  operator input path (endpoints validate before calling). Does NOT
   *  guard self-demotion; that's session-aware and lives in the mount
   *  layer. */
  readonly setUserRole: (
    userId: string,
    role: StaffRole | null,
  ) => Promise<boolean>;
  /** Invite a staff member by email: pre-create the user row
   *  (`emailVerified: 0`) with the role already assigned, so the
   *  invitee's FIRST sign-in with that email lands with the role in
   *  effect — no second assignment step. Magic-link / email-OTP
   *  sign-ins match the row by email; social sign-ins with the same
   *  email link onto it only when the provider is listed in
   *  `accountLinking.trustedProviders` (document this to operators).
   *  Email is normalized (trim + lowercase). Returns `exists` instead
   *  of throwing when the email already has a row. */
  readonly inviteUser: (
    email: string,
    role: StaffRole,
  ) => Promise<InviteUserResult>;
  readonly sendStaffInvitation?: (email: string, role: StaffRole) => Promise<void>;
  /** Delete an invitation row. Guarded to rows nobody ever signed in
   *  to (`emailVerified = 0` AND no linked `account` row) so a real
   *  user with sessions/accounts can never be cascade-deleted through
   *  this path. Returns false when the row didn't match the guard. */
  readonly revokeInvite: (userId: string) => Promise<boolean>;
  /** Register an OAuth/OIDC client when `oauthProvider` is configured.
   *  Uses Better Auth's own provider plugin endpoint and returns the
   *  client secret only on creation. The caller must pass the current
   *  owner/admin request headers so Better Auth can enforce privileges. */
  readonly registerOAuthClient: (
    input: RegisterOAuthClientInput,
  ) => Promise<RegisteredOAuthClient>;
}

const SETUP_INCOMPLETE_AUTHS = new WeakSet<MantleAuth>();

/** True only for the fail-closed facade returned by createSetupIncompleteAuth. */
export function isSetupIncompleteAuth(auth: MantleAuth): boolean {
  return SETUP_INCOMPLETE_AUTHS.has(auth);
}

const LEGACY_DCR_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const LEGACY_DCR_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

export function createMantleAuth(config: CreateMantleAuthOptions): MantleAuth {
  const auth = buildAuth(config);
  const ready = auth.$context.then(() => undefined);
  // Observe eager initialization even for low-level callers; keep the original
  // rejection available to callers awaiting ready and Better Auth's handlers.
  void ready.catch(() => {});
  // Auth owns its schema even when content uses a different semantic store.
  // Keep schema work lazy: static/plan-only routes must not prepare tables.
  let schemaReady: Promise<void> | null = null;
  const prepareAuth = (): Promise<void> => schemaReady ??= (async () => {
    const context = await auth.$context;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(context.tables)));
    const id = `auth-schema:1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    try {
      const applied = await config.driver.prepare("SELECT id FROM _migrations WHERE id = ?").bind(id).first<{ id: string }>();
      if (applied?.id === id) return;
    } catch (error) {
      // A new, auth-only database has no legacy Runtime ledger yet.
      if (!/no such table: _migrations/i.test(String(error))) throw error;
    }
    const { compileMigrations } = await getMigrations(context.options);
    await config.driver.migrations.runAll([{
      id,
      description: "Selected Better Auth schema and staff-role access path",
      sql: `${await compileMigrations()}\nCREATE INDEX IF NOT EXISTS user_role_idx ON user (role) WHERE role IS NOT NULL;`,
    }]);
  })().catch(error => { schemaReady = null; throw error; });

  const basePath = normalizeAuthBasePath(config.basePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = auth.api as any;
  const localJwksCacheKey = {};
  let dpopReplayStore: DpopReplayStore | null = null;
  const getDpopReplayStore = async (): Promise<DpopReplayStore> => {
    if (dpopReplayStore) return dpopReplayStore;
    const context = await auth.$context;
    dpopReplayStore = createDpopReplayStore(context.internalAdapter);
    return dpopReplayStore;
  };
  const verifyAccessToken = config.oauthProvider
    ? async (token: string, audience: string) => {
        await prepareAuth();
        const context = await auth.$context;
        const claims = await verifyOAuthJwtWithLocalJwks(
          token,
          audience,
          context.baseURL,
          async () => api.getJwks(),
          localJwksCacheKey,
        );
        if (config.oauthProvider?.mcpResource && (audience === config.oauthProvider.mcpResource || config.oauthProvider.resources?.includes(audience))) {
          await assertActiveUserGrant(config.driver, claims, audience);
        }
        return claims;
      }
    : null;
  let nextDcrCleanupAt = 0;

  const pruneExpiredDynamicClients = async (): Promise<void> => {
    const now = Date.now();
    if (!config.oauthProvider?.mcpResource || now < nextDcrCleanupAt) return;
    // Set before awaiting so concurrent OAuth requests do not fan out writes.
    nextDcrCleanupAt = now + LEGACY_DCR_CLEANUP_INTERVAL_MS;
    try {
      await config.driver
        .prepare(
          "DELETE FROM oauthClient WHERE clientDiscoveryId IS NULL AND userId IS NULL AND referenceId IS NULL AND createdAt < ?",
        )
        .bind(new Date(now - LEGACY_DCR_TTL_MS).toISOString())
        .run();
    } catch (error) {
      // Cleanup is bounded storage hygiene, not an authorization decision.
      console.error("[better-auth] legacy DCR cleanup failed", error);
    }
  };

  return {
    basePath,
    ready,
    ...(config.oauthProvider?.mcpResource
      ? { mcpResource: config.oauthProvider.mcpResource }
      : {}),
    handler: async (request) => {
      await prepareAuth();
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith(`${basePath}/oauth2/`)) {
        await pruneExpiredDynamicClients();
      }
      return normalizeAuthResponseCookies(await auth.handler(request));
    },
    getSession: async (request) => {
      let session;
      try {
        session = await api.getSession({ headers: request.headers });
      } catch {
        // Existing sessions resolve from KV without paying the schema-ledger read.
        // A fresh database with a stale cookie prepares once, then retries safely.
        await prepareAuth();
        session = await api.getSession({ headers: request.headers });
      }
      return session
        ? {
            ...session,
            user: {
              ...session.user,
              // Secondary storage can outlive or be shared across a store replacement.
              // Its user snapshot is therefore not authoritative for staff access.
              ...(!config.sessionCache && Object.hasOwn(session.user, "role")
                ? { roleCurrent: true as const }
                : {}),
            },
          }
        : null;
    },
    getUserRole: async (userId) => {
      await prepareAuth();
      const row = await config.driver
        .prepare("SELECT role FROM user WHERE id = ? LIMIT 1")
        .bind(userId)
        .first<{ role: string | null }>();
      return row?.role ?? null;
    },
    getUser: async (userId) => {
      await prepareAuth();
      const row = await config.driver
        .prepare(
          "SELECT id, email, name, image, role, githubLogin, emailVerified, createdAt FROM user WHERE id = ? LIMIT 1",
        )
        .bind(userId)
        .first<{
          id: string;
          email: string;
          name: string;
          image: string | null;
          role: string | null;
          githubLogin: string | null;
          emailVerified: number;
          createdAt: string;
        }>();
      if (!row) return null;
      const createdAt = new Date(row.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error("Auth user row has an invalid createdAt timestamp.");
      }
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        image: row.image,
        role: row.role,
        githubLogin: row.githubLogin,
        emailVerified: row.emailVerified !== 0,
        createdAt,
      };
    },
    getProviderAccessToken: async (request, providerId) => {
      await prepareAuth();
      const session = await api.getSession({ headers: request.headers });
      const userId = session?.user?.id;
      const account = userId
        ? await config.driver
          .prepare("SELECT id FROM account WHERE userId = ? AND providerId = ? LIMIT 1")
          .bind(userId, providerId)
          .first<{ id: string }>()
        : null;
      if (!account) {
        throw new Error(
          `getProviderAccessToken: provider '${providerId}' is not linked to the current user.`,
        );
      }
      return getProviderAccessTokenForRequest(api, request, account.id, providerId);
    },
    verifyOAuthAccessToken: async (tokenOrRequest, options) => {
      return verifyOAuthJwt(
        tokenOrRequest,
        options,
        verifyAccessToken,
        getDpopReplayStore,
      );
    },
    getOAuthConsentRequest: async (request) => {
      if (!config.oauthProvider) return null;
      const url = new URL(request.url);
      const clientId = url.searchParams.get("client_id");
      if (!clientId || !url.search) return null;
      await prepareAuth();
      const oauthQuery = url.search.slice(1);
      const client = await api.getOAuthClientPublicPrelogin({
        headers: request.headers,
        body: { client_id: clientId, oauth_query: oauthQuery },
      });
      const redirectUri = url.searchParams.get("redirect_uri") ??
        (Array.isArray(client?.redirect_uris) &&
            typeof client.redirect_uris[0] === "string"
          ? client.redirect_uris[0]
          : "");
      return {
        clientName: typeof client?.client_name === "string"
          ? client.client_name
          : clientId,
        redirectUri,
        scopes: (url.searchParams.get("scope") ?? "")
          .split(/\s+/u)
          .filter(Boolean),
        oauthQuery,
      };
    },
    completeOAuthConsent: async (request, accept) => {
      if (!config.oauthProvider) {
        throw new Error("completeOAuthConsent: oauthProvider is not configured.");
      }
      const form = await request.formData();
      const oauthQuery = form.get("oauth_query");
      if (typeof oauthQuery !== "string" || oauthQuery.length === 0) {
        throw new Error("completeOAuthConsent: oauth_query is missing.");
      }
      await prepareAuth();
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      const response = await auth.handler(new Request(
        new URL(`${basePath}/oauth2/consent`, request.url),
        {
          method: "POST",
          headers,
          body: JSON.stringify({ accept, oauth_query: oauthQuery }),
        },
      ));
      if (!response.ok) {
        throw new Error(`completeOAuthConsent: Better Auth returned ${response.status}.`);
      }
      const result = await response.json() as { url?: unknown };
      if (!result || typeof result.url !== "string") {
        throw new Error("completeOAuthConsent: Better Auth omitted the redirect URL.");
      }
      return result.url;
    },
    ...(config.oauthProvider
      ? {
          listOAuthConsents: async (userId: string) => {
            await prepareAuth();
            const result = await config.driver
              .prepare(
                `SELECT consent.id, consent.clientId,
                        COALESCE(client.name, consent.clientId) AS clientName,
                        consent.scopes
                   FROM oauthConsent AS consent
                   LEFT JOIN oauthClient AS client ON client.clientId = consent.clientId
                  WHERE consent.userId = ?
                  ORDER BY consent.updatedAt DESC, consent.id ASC`,
              )
              .bind(userId)
              .all<{
                id: string;
                clientId: string;
                clientName: string;
                scopes: string;
              }>();
            return result.map((row) => ({
              id: row.id,
              clientId: row.clientId,
              clientName: row.clientName,
              scopes: parseStoredStringArray(row.scopes) ?? [],
            }));
          },
          revokeOAuthConsent: async (userId: string, consentId: string) => {
            await prepareAuth();
            const consent = await config.driver
              .prepare(
                "SELECT clientId FROM oauthConsent WHERE id = ? AND userId = ? LIMIT 1",
              )
              .bind(consentId, userId)
              .first<{ clientId: string }>();
            if (!consent) return false;
            const revokedAt = new Date().toISOString();
            await config.driver.batch([
              config.driver
                .prepare(
                  "UPDATE oauthRefreshToken SET revoked = ? WHERE userId = ? AND clientId = ? AND revoked IS NULL",
                )
                .bind(revokedAt, userId, consent.clientId),
              config.driver
                .prepare(
                  "UPDATE oauthAccessToken SET revoked = ? WHERE userId = ? AND clientId = ? AND revoked IS NULL",
                )
                .bind(revokedAt, userId, consent.clientId),
              config.driver
                .prepare(
                  `DELETE FROM verification
                    WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') END = 'authorization_code'
                      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.userId') END = ?
                      AND CASE WHEN json_valid(value) THEN json_extract(value, '$.query.client_id') END = ?`,
                )
                .bind(userId, consent.clientId),
              config.driver
                .prepare("DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?")
                .bind(userId, consent.clientId),
            ]);
            return true;
          },
        }
      : {}),
    methods: config.methods.map<AuthMethodInfo>((m) => {
      switch (m.kind) {
        case "social":
          return { kind: "social", provider: m.provider };
        case "oauth":
          return {
            kind: "oauth",
            providerId: m.options.providerId,
            ...(m.displayName ? { displayName: m.displayName } : {}),
          };
        case "email-otp":
        case "magic-link":
          return { kind: m.kind };
      }
    }),
    listLinkedAccounts: async (userId) => {
      await prepareAuth();
      const result = await config.driver
        .prepare(
          "SELECT id, providerId, accountId, createdAt, updatedAt FROM account WHERE userId = ? ORDER BY createdAt ASC, id ASC",
        )
        .bind(userId)
        .all<{
          id: string;
          providerId: string;
          accountId: string;
          createdAt: string;
          updatedAt: string;
        }>();
      return result.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        accountId: row.accountId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    },
    unlinkAccount: async (userId, providerId) => {
      await prepareAuth();
      const result = await config.driver
        .prepare("DELETE FROM account WHERE userId = ? AND providerId = ?")
        .bind(userId, providerId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },
    listUsers: async () => {
      await prepareAuth();
      const placeholders = STAFF_ROLES.map(() => "?").join(",");
      const result = await config.driver
        .prepare(
          `SELECT id, email, name, role, githubLogin, emailVerified, createdAt FROM user WHERE role IN (${placeholders}) ORDER BY createdAt ASC, id ASC`,
        )
        .bind(...STAFF_ROLES)
        .all<{
          id: string;
          email: string;
          name: string;
          role: string | null;
          githubLogin: string | null;
          emailVerified: number;
          createdAt: string;
        }>();
      return result.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        githubLogin: row.githubLogin,
        emailVerified: row.emailVerified !== 0,
        createdAt: new Date(row.createdAt),
      }));
    },
    listMembers: async ({ search, cursor, cursorDirection = "forward", limit }) => {
      await prepareAuth();
      const parsedCursor = cursor ? decodeMemberCursor(cursor) : null;
      const backward = cursorDirection === "backward";
      const conditions = [
        `(role IS NULL OR role NOT IN (${STAFF_ROLES.map(() => "?").join(",")}))`,
      ];
      const bindings: unknown[] = [...STAFF_ROLES];
      const term = search?.trim().toLowerCase();
      if (term) {
        conditions.push("(LOWER(id) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')");
        const like = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
        bindings.push(like, like, like);
      }
      if (parsedCursor) {
        const operator = backward ? "<" : ">";
        conditions.push(`(createdAt ${operator} ? OR (createdAt = ? AND id ${operator} ?))`);
        bindings.push(parsedCursor[0], parsedCursor[0], parsedCursor[1]);
      }
      bindings.push(limit + 1);
      const result = await config.driver
        .prepare(
          `SELECT id, email, name, emailVerified, createdAt FROM user WHERE ${conditions.join(" AND ")} ORDER BY createdAt ${backward ? "DESC" : "ASC"}, id ${backward ? "DESC" : "ASC"} LIMIT ?`,
        )
        .bind(...bindings)
        .all<{
          id: string;
          email: string;
          name: string;
          emailVerified: number;
          createdAt: string;
        }>();
      const rows = result.slice(0, limit);
      if (backward) rows.reverse();
      const items = rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: row.emailVerified !== 0,
        createdAt: new Date(row.createdAt),
      }));
      const hasMore = result.length > limit;
      return {
        items,
        previousCursor:
          (backward ? hasMore : Boolean(parsedCursor)) && rows[0]
            ? encodeMemberCursor(rows[0].createdAt, rows[0].id)
            : null,
        nextCursor:
          (backward ? Boolean(parsedCursor) : hasMore) && rows.at(-1)
            ? encodeMemberCursor(rows.at(-1)!.createdAt, rows.at(-1)!.id)
            : null,
      };
    },
    setUserRole: async (userId, role) => {
      if (role !== null && !STAFF_ROLE_SET.has(role)) {
        throw new Error(
          `setUserRole: '${role}' is not a staff role — expected one of [${STAFF_ROLES.join(", ")}] or null.`,
        );
      }
      await prepareAuth();
      if (config.sessionCache) {
        const context = await auth.$context;
        return !!await context.internalAdapter.updateUser(userId, {
          role,
          updatedAt: new Date(),
        });
      }
      const result = await config.driver
        .prepare("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?")
        .bind(role, new Date().toISOString(), userId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },
    inviteUser: async (email, role) => {
      if (!STAFF_ROLE_SET.has(role)) {
        throw new Error(
          `inviteUser: '${role}' is not a staff role — expected one of [${STAFF_ROLES.join(", ")}].`,
        );
      }
      await prepareAuth();
      const normalized = email.trim().toLowerCase();
      const existing = await config.driver
        .prepare("SELECT id FROM user WHERE email = ? LIMIT 1")
        .bind(normalized)
        .first<{ id: string }>();
      if (existing) return { kind: "exists", id: existing.id };
      const id = generateUserId();
      const now = new Date().toISOString();
      // `name` defaults to the address's local part — Better Auth
      // requires NOT NULL, and the invitee's real display name arrives
      // with their first sign-in (social) or stays editable later.
      await config.driver
        .prepare(
          "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(id, normalized.split("@")[0] ?? normalized, normalized, now, now, role)
        .run();
      return { kind: "created", id };
    },
    ...(config.staffInvitationSender ? {
      sendStaffInvitation: async (email: string, role: StaffRole) => {
        const normalized = email.trim().toLowerCase();
        await config.staffInvitationSender!.send({
          to: normalized,
          ...staffInvitationEmail(role, new URL("/admin/sign-in", config.baseURL).href),
          locale: "en",
          category: "auth.staff-invitation",
        });
      },
    } : {}),
    revokeInvite: async (userId) => {
      await prepareAuth();
      const result = await config.driver
        .prepare(
          "DELETE FROM user WHERE id = ? AND emailVerified = 0 AND NOT EXISTS (SELECT 1 FROM account WHERE account.userId = user.id)",
        )
        .bind(userId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },
    registerOAuthClient: async (input) => {
      if (!config.oauthProvider) {
        throw new Error("registerOAuthClient: oauthProvider is not configured.");
      }
      await prepareAuth();
      const created = await api.adminCreateOAuthClient({
        headers: new Headers(input.requestHeaders),
        body: {
          redirect_uris: [...input.redirectUris],
          ...(input.scope ? { scope: input.scope.join(" ") } : {}),
          ...(input.clientName ? { client_name: input.clientName } : {}),
          ...(input.clientUri ? { client_uri: input.clientUri } : {}),
          ...(input.logoUri ? { logo_uri: input.logoUri } : {}),
          ...(input.contacts ? { contacts: [...input.contacts] } : {}),
          ...(input.tosUri ? { tos_uri: input.tosUri } : {}),
          ...(input.policyUri ? { policy_uri: input.policyUri } : {}),
          ...(input.postLogoutRedirectUris
            ? { post_logout_redirect_uris: [...input.postLogoutRedirectUris] }
            : {}),
          ...(input.tokenEndpointAuthMethod
            ? { token_endpoint_auth_method: input.tokenEndpointAuthMethod }
            : {}),
          ...(input.grantTypes ? { grant_types: [...input.grantTypes] } : {}),
          ...(input.responseTypes ? { response_types: [...input.responseTypes] } : {}),
          ...(input.applicationType ? { application_type: input.applicationType } : {}),
          ...(input.skipConsent !== undefined ? { skip_consent: input.skipConsent } : {}),
          ...(input.enableEndSession !== undefined
            ? { enable_end_session: input.enableEndSession }
            : {}),
          ...(input.requirePKCE !== undefined ? { require_pkce: input.requirePKCE } : {}),
          ...(input.subjectType ? { subject_type: input.subjectType } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
      return mapRegisteredOAuthClient(created);
    },
  };
}

export interface SetupIncompleteAuthOptions {
  readonly basePath?: string;
  readonly message?: string;
  readonly response?: () => Response | Promise<Response>;
}

/**
 * Safe Auth facade for first-deploy/bootstrap windows where an
 * adopter's public Worker should boot before staff sign-in providers
 * have been provisioned. Auth-gated routes should still be blocked by
 * the consumer; this facade never authenticates anyone.
 */
export function createSetupIncompleteAuth(
  options: SetupIncompleteAuthOptions = {},
): MantleAuth {
  const basePath = normalizeAuthBasePath(options.basePath);
  const message = options.message ?? "Auth is not configured yet.";
  const response =
    options.response ??
    (() =>
      Response.json(
        { error: "setup_incomplete", message },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      ));
  const auth: MantleAuth = {
    basePath,
    handler: async () => response(),
    getSession: async () => null,
    getUserRole: async () => null,
    getUser: async () => null,
    getProviderAccessToken: async () => {
      throw new Error(message);
    },
    verifyOAuthAccessToken: async () => ({
      ok: false,
      status: 401,
      reason: "invalid-token",
    }),
    getOAuthConsentRequest: async () => null,
    completeOAuthConsent: async () => {
      throw new Error(message);
    },
    methods: [],
    listLinkedAccounts: async () => [],
    unlinkAccount: async () => false,
    listUsers: async () => [],
    listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }),
    setUserRole: async () => false,
    inviteUser: async () => {
      throw new Error(message);
    },
    revokeInvite: async () => false,
    registerOAuthClient: async () => {
      throw new Error(message);
    },
  };
  SETUP_INCOMPLETE_AUTHS.add(auth);
  return auth;
}

/** Pin the session-bound Better Auth request and secret-minimizing response mapping. */
export async function getProviderAccessTokenForRequest(
  api: {
    getAccessToken(input: {
      headers: Headers;
      body: { accountId: string };
    }): Promise<unknown>;
  },
  request: Request,
  accountId: string,
  providerId: string,
): Promise<ProviderAccessToken> {
  const value = (await api.getAccessToken({
    headers: request.headers,
    body: { accountId },
  })) as {
    accessToken?: unknown;
    accessTokenExpiresAt?: unknown;
    scopes?: unknown;
  };
  if (typeof value?.accessToken !== "string") {
    throw new Error(
      `getProviderAccessToken: provider '${providerId}' returned no access token.`,
    );
  }
  return {
    accessToken: value.accessToken,
    ...(value.accessTokenExpiresAt instanceof Date
      ? { accessTokenExpiresAt: value.accessTokenExpiresAt }
      : {}),
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

function scopesFromClaim(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

function parseStoredStringArray(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function assertActiveUserGrant(
  driver: DatabaseDriver,
  claims: Record<string, unknown>,
  audience: string,
): Promise<void> {
  const userId = claims["sub"];
  const clientId = claims["azp"];
  const sessionId = claims["sid"];
  const consentId = claims["mantle_consent_id"];
  if (
    typeof userId !== "string" ||
    typeof clientId !== "string" ||
    typeof sessionId !== "string" ||
    typeof consentId !== "string" || !consentId
  ) {
    throw new Error("OAuth token is not bound to a user session.");
  }
  const result = await driver
    .prepare(
      "SELECT c.resources, c.scopes FROM oauthConsent AS c " +
        "JOIN session AS s ON s.id = ? AND s.userId = c.userId AND s.expiresAt > ? " +
        "WHERE c.id = ? AND c.userId = ? AND c.clientId = ?",
    )
    .bind(sessionId, new Date().toISOString(), consentId, userId, clientId)
    .first<{ resources: string | null; scopes: string }>();
  const tokenScopes = scopesFromClaim(claims["scope"]);
  const resources = parseStoredStringArray(result?.resources);
  const scopes = parseStoredStringArray(result?.scopes);
  const active = resources?.includes(audience) === true && scopes !== null &&
    tokenScopes.every((scope) => scopes.includes(scope));
  if (!active) throw new Error("OAuth authorization grant is no longer active.");
}

type LocalJwksFetcher = Exclude<
  Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
  string
>;

export function verifyOAuthJwtWithLocalJwks(
  token: string,
  audience: string,
  issuer: string,
  jwksFetch: LocalJwksFetcher,
  jwksCacheKey?: object,
): Promise<Record<string, unknown>> {
  return verifyJwsAccessToken(token, {
    jwksFetch,
    ...(jwksCacheKey ? { jwksCacheKey } : {}),
    verifyOptions: { audience, issuer },
  });
}

export async function verifyOAuthJwt(
  tokenOrRequest: string | Request,
  options: {
    readonly audience: string;
    readonly scopes?: readonly string[];
  },
  verify: ((token: string, audience: string) => Promise<Record<string, unknown>>) | null,
  getDpopReplayStore?: () => Promise<DpopReplayStore>,
): Promise<OAuthAccessTokenVerification> {
  const request = typeof tokenOrRequest === "string" ? null : tokenOrRequest;
  const authorization = parseAccessTokenAuthorization(
    request?.headers.get("authorization") ?? `Bearer ${tokenOrRequest}`,
  );
  const token = authorization?.token;
  // JWT compact serialization has exactly three non-empty parts.
  // Reject opaque tokens before any network/JWKS work.
  if (
    !verify ||
    !token ||
    token.split(".").length !== 3 ||
    token.split(".").some((part) => part.length === 0)
  ) {
    return { ok: false, status: 401, reason: "invalid-token" };
  }
  try {
    const claims = await verify(token, options.audience);
    await enforceDpopBinding({
      payload: claims,
      authorization,
      proofJwt: request?.headers.get("dpop"),
      method: request?.method ?? "GET",
      url: request?.url ?? options.audience,
      ...(request && authorization.scheme === "DPoP" && getDpopReplayStore
        ? { replayStore: await getDpopReplayStore() }
        : {}),
    });
    if (typeof claims["sub"] !== "string" || claims["sub"].length === 0) {
      return { ok: false, status: 401, reason: "invalid-token" };
    }
    const scopes = scopesFromClaim(claims["scope"]);
    const missingScopes = (options.scopes ?? []).filter(
      (scope) => !scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      return {
        ok: false,
        status: 403,
        reason: "insufficient-scope",
        missingScopes,
      };
    }
    return {
      ok: true,
      userId: claims["sub"],
      clientId: typeof claims["azp"] === "string" ? claims["azp"] : null,
      credentialId: typeof claims["jti"] === "string" ? claims["jti"] : null,
      scopes,
    };
  } catch (error) {
    if (isDpopBindingError(error)) {
      return { ok: false, status: 401, reason: "invalid-dpop-proof" };
    }
    return { ok: false, status: 401, reason: "invalid-token" };
  }
}

export function mapRegisteredOAuthClient(value: unknown): RegisteredOAuthClient {
  const row = value as {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
    scope?: string;
    client_name?: string;
    client_uri?: string;
    token_endpoint_auth_method?: string;
    application_type?: "web" | "native";
  };
  if (!row.client_id || !Array.isArray(row.redirect_uris)) {
    throw new Error("registerOAuthClient: Better Auth returned an invalid client.");
  }
  return {
    clientId: row.client_id,
    ...(row.client_secret && row.token_endpoint_auth_method !== "none"
      ? { clientSecret: row.client_secret }
      : {}),
    redirectUris: row.redirect_uris,
    ...(row.scope ? { scope: row.scope.split(" ").filter(Boolean) } : {}),
    ...(row.client_name ? { clientName: row.client_name } : {}),
    ...(row.client_uri ? { clientUri: row.client_uri } : {}),
    ...(row.token_endpoint_auth_method
      ? { tokenEndpointAuthMethod: row.token_endpoint_auth_method }
      : {}),
    ...(row.application_type ? { applicationType: row.application_type } : {}),
  };
}

/** Random 32-char alphanumeric id, shaped like Better Auth's own user
 *  ids so invited rows are indistinguishable from organically-created
 *  ones. Modulo bias over 62 symbols is irrelevant here — ids need
 *  uniqueness, not uniform entropy. */
function generateUserId(): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length]!;
  return id;
}
