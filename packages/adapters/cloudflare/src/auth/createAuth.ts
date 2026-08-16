import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import {
  applyDefaultAccessTokenExpiry,
  refreshAccessToken,
  validateAuthorizationCode,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import type { SocialProvider } from "better-auth/social-providers";
import { admin, emailOTP, jwt, magicLink } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import {
  genericOAuth,
  type GenericOAuthConfig,
} from "better-auth/plugins/generic-oauth";
import { splitSetCookieHeader } from "better-auth/cookies";
import { oauthProvider, type Scope } from "@better-auth/oauth-provider";
import { decodeMemberCursor, encodeMemberCursor } from "@aotter/mantle-admin";
import type { EmailSender } from "@aotter/mantle-runtime";
import { STAFF_ROLES, type StaffRole } from "@aotter/mantle-spec";

export { decodeMemberCursor, encodeMemberCursor };
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
export type SocialProviderId = SocialProvider;

export type OAuthProfileMapper = (
  profile: Readonly<Record<string, unknown>>,
) => OAuthMappedProfile | Promise<OAuthMappedProfile>;

export type OAuthMappedProfile = Readonly<Partial<{
  id: string | number;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  githubLogin: string | null;
}>>;

/**
 * Auth method config (discriminated union). Each `kind` is one auth
 * surface adopters can opt into; adding a new method = adding a new
 * union case here, not a new top-level key on `CreateAuthConfig` —
 * per ADR-0014.
 *
 * `kind: "social"` is the OAuth-based bucket — `provider` discriminates
 * the upstream IDP. We use one case rather than one-per-provider so
 * adding (e.g.) Apple doesn't churn the union; Better Auth's
 * provider-shaped quirks ride in `extras`.
 */
export type AuthMethodConfig =
  | {
      readonly kind: "social";
      readonly provider: SocialProviderId;
      readonly clientId: string;
      readonly clientSecret: string;
      /** Override the OAuth callback URL Better Auth tells the IDP to
       *  redirect to. The consumer is then responsible for forwarding
       *  requests at that URI to `auth.handler`. */
      readonly redirectURI?: string;
      /** OAuth scopes. Defaults vary per provider; only set when the
       *  default doesn't cover what you need (e.g. extra Google
       *  scopes for a Drive integration). */
      readonly scope?: ReadonlyArray<string>;
      /** Escape hatch for provider-specific options Better Auth
       *  accepts but we don't surface as first-class fields —
       *  Microsoft Entra ID's `tenantId`, Reddit's `duration`,
       *  per-provider `prompt` / `accessType` knobs, etc. Merged
       *  into the provider's config verbatim.
       *
       *  Reserved keys are rejected at construction so a stray entry
       *  can't silently shadow first-class config: `clientId`,
       *  `clientSecret`, `redirectURI`, `scope`, `mapProfileToUser`.
       *  Use the first-class fields for those.
       *
       *  Note: Apple specifically does NOT accept teamId/keyId/
       *  privateKey via Better Auth — its `clientSecret` is the
       *  pre-signed ES256 JWT the adopter generates out-of-band. */
      readonly extras?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "oauth";
      /** Better Auth generic OAuth provider id. Stable across sign-in
       *  start (`/sign-in/oauth2`) and callback
       *  (`/oauth2/callback/:providerId`). */
      readonly providerId: string;
      /** Human label surfaced by `/api/auth/methods` so the admin SPA
       *  can render "Continue with Mantle Platform" without knowing
       *  product-specific provider ids. */
      readonly displayName?: string;
      readonly clientId: string;
      readonly clientSecret?: string;
      /** OIDC discovery document URL. Prefer this over hand-wiring
       *  authorization/token/userinfo URLs. */
      readonly discoveryUrl?: string;
      readonly issuer?: string;
      readonly requireIssuerValidation?: boolean;
      readonly authorizationUrl?: string;
      readonly tokenUrl?: string;
      readonly userInfoUrl?: string;
      readonly scopes?: ReadonlyArray<string>;
      readonly redirectURI?: string;
      readonly pkce?: boolean;
      readonly authentication?: "basic" | "post";
      readonly prompt?:
        | "none"
        | "login"
        | "create"
        | "consent"
        | "select_account"
        | "select_account consent"
        | "login consent";
      /** RFC 8707 resource indicator. Mantle carries it through the
       * authorization request, code exchange, and refresh exchange. */
      readonly resource?: string;
      /** Maps the validated provider profile into the site-local Better Auth user. */
      readonly mapProfileToUser?: OAuthProfileMapper;
    }
  | {
      readonly kind: "email-otp";
      /** Transactional-email sender. SDK never owns body templates;
       *  the locale is passed through so the sender can branch. */
      readonly sender: EmailSender;
      /** OTP length (Better Auth default 6). */
      readonly otpLength?: number;
      /** OTP TTL in seconds (Better Auth default 300 = 5 min). */
      readonly expiresInSeconds?: number;
      /** Allowed attempts before the OTP locks (Better Auth default 3). */
      readonly allowedAttempts?: number;
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
      /** Link TTL in seconds. Defaults to 900 (15 min); see
       *  `MAGIC_LINK_DEFAULT_EXPIRES_SECONDS` for rationale. */
      readonly expiresInSeconds?: number;
      /** Allowed verification attempts. Defaults to 3 to survive
       *  mail-prefetcher URL scans (Outlook Safe Links etc.); see
       *  `MAGIC_LINK_DEFAULT_ALLOWED_ATTEMPTS`. */
      readonly allowedAttempts?: number;
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
  readonly cachedTrustedClients?: ReadonlySet<string>;
  /** Explicit JWT audiences this authorization server may mint. */
  readonly validAudiences?: ReadonlyArray<string>;
  readonly clientPrivileges?: (context: {
    readonly headers: Headers;
    readonly action: "create" | "read" | "update" | "delete" | "list" | "rotate";
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
  readonly type?: "web" | "native" | "user-agent-based";
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
  readonly type?: string;
  readonly public?: boolean;
}

export interface CreateAuthConfig {
  readonly database: D1Database;
  readonly baseURL: string;
  /** Better Auth route prefix. Defaults to `/api/auth`. Set this when
   *  multiple auth instances live in one Worker, e.g. hosted platform
   *  provider + site staff auth + launch GitHub auth. */
  readonly basePath?: string;
  /** Same-origin destination for auth failures. Defaults to `/`. */
  readonly errorURL?: string;
  readonly secret: string;
  /** Registered auth methods. Boot fails fast if empty. */
  readonly methods: ReadonlyArray<AuthMethodConfig>;
  /** First-user-becomes-owner rule. Without it, the `owner` role must
   *  be assigned manually in D1. */
  readonly bootstrapOwner?: BootstrapOwnerRule;
  /** Better Auth's built-in rate limit. Defaults off; production
   *  deployments should set it. */
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
  /** Turn this Better Auth instance into an OAuth/OIDC provider.
   *  Consumer sites should use `methods: [{ kind: "oauth", ... }]`
   *  against its discovery document. */
  readonly oauthProvider?: OAuthProviderConfig;
}

function normalizeAuthBasePath(basePath: string | undefined): string {
  if (basePath === undefined) return "/api/auth";
  const trimmed = basePath.trim();
  if (trimmed === "") return "/api/auth";
  if (!trimmed.startsWith("/")) {
    throw new Error("createAuth: basePath must start with '/'.");
  }
  if (trimmed === "/") {
    throw new Error("createAuth: basePath must not be '/'.");
  }
  if (trimmed.endsWith("/")) {
    return trimmed.replace(/\/+$/, "");
  }
  return trimmed;
}

function normalizeAuthErrorURL(errorURL: string | undefined, baseURL: string): string {
  const base = new URL(baseURL);
  const resolved = new URL(errorURL ?? "/", base);
  if (resolved.origin !== base.origin) {
    throw new Error("createAuth: errorURL must be same-origin with baseURL.");
  }
  return `${resolved.pathname}${resolved.search}`;
}

/** @internal Exported for regression tests. */
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

/**
 * Keys that `extras` MUST NOT contain — they have first-class fields
 * on `AuthMethodConfig` and / or are managed by this adapter (the
 * github `mapProfileToUser` shim). Allowing them through would let a
 * stray entry shadow credentials or break bootstrap promotion.
 */
const SOCIAL_EXTRAS_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "clientId",
  "clientSecret",
  "redirectURI",
  "scope",
  "mapProfileToUser",
]);

/** @internal exported for unit tests; not part of the public API. */
export function buildSocialProviders(
  methods: ReadonlyArray<AuthMethodConfig>,
): BetterAuthOptions["socialProviders"] {
  // Better Auth's typed `socialProviders` shape names every provider
  // key individually; assigning by computed string requires an index
  // signature, so we build through a plain map and cast once at the
  // return. The runtime shape matches Better Auth's expectations.
  const out: Record<string, Record<string, unknown>> = {};
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
        `createAuth: social provider '${method.provider}' is registered more than once; ` +
          `each provider can have only one methods[] entry. Remove the redundant entry or pick a different provider.`,
      );
    }
    seenProviders.add(method.provider);
    if (method.extras) {
      for (const key of Object.keys(method.extras)) {
        if (SOCIAL_EXTRAS_RESERVED_KEYS.has(key)) {
          throw new Error(
            `createAuth: social method '${method.provider}' has reserved key '${key}' in \`extras\`. ` +
              `Use the first-class field instead — \`extras\` is for provider-specific options only.`,
          );
        }
      }
    }
    // GitHub-specific: stash the github login on `user.githubLogin`
    // so `bootstrapOwner: { match: "github-login" }` keeps working.
    // Other providers don't need an analogous shim because bootstrap
    // matches on email for them.
    const githubProfileMapper =
      method.provider === "github"
        ? {
            mapProfileToUser: (profile: { login?: string }) => ({
              githubLogin: profile.login,
            }),
          }
        : {};
    out[method.provider] = {
      clientId: method.clientId,
      clientSecret: method.clientSecret,
      ...(method.redirectURI ? { redirectURI: method.redirectURI } : {}),
      ...(method.scope ? { scope: [...method.scope] } : {}),
      ...(method.extras ?? {}),
      ...githubProfileMapper,
    };
  }
  return out as BetterAuthOptions["socialProviders"];
}

/** @internal exported for unit tests; not part of the public API. */
export function buildGenericOAuthProviders(
  methods: ReadonlyArray<AuthMethodConfig>,
): Array<{
  providerId: string;
  displayName?: string;
  clientId: string;
  clientSecret?: string;
  discoveryUrl?: string;
  issuer?: string;
  requireIssuerValidation?: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
  redirectURI?: string;
  pkce?: boolean;
  authentication?: "basic" | "post";
  prompt?: Extract<AuthMethodConfig, { kind: "oauth" }>["prompt"];
  resource?: string;
  mapProfileToUser?: GenericOAuthConfig["mapProfileToUser"];
  authorizationUrlParams?: Record<string, string>;
  tokenUrlParams?: Record<string, string>;
}> {
  const seenProviderIds = new Set<string>();
  const socialProviderIds: ReadonlySet<string> = new Set(
    methods.flatMap((method) =>
      method.kind === "social" ? [method.provider] : [],
    ),
  );
  const out: ReturnType<typeof buildGenericOAuthProviders> = [];
  for (const method of methods) {
    if (method.kind !== "oauth") continue;
    if (socialProviderIds.has(method.providerId)) {
      throw new Error(
        `createAuth: OAuth providerId '${method.providerId}' conflicts with a registered social provider id. Provider ids must be unique across methods[].`,
      );
    }
    if (seenProviderIds.has(method.providerId)) {
      throw new Error(
        `createAuth: OAuth provider '${method.providerId}' is registered more than once; ` +
          `each providerId can have only one methods[] entry.`,
      );
    }
    seenProviderIds.add(method.providerId);
    if (!method.discoveryUrl && !(method.authorizationUrl && method.tokenUrl)) {
      throw new Error(
        `createAuth: OAuth provider '${method.providerId}' needs either discoveryUrl or both authorizationUrl and tokenUrl.`,
      );
    }
    out.push({
      providerId: method.providerId,
      ...(method.displayName ? { displayName: method.displayName } : {}),
      clientId: method.clientId,
      ...(method.clientSecret ? { clientSecret: method.clientSecret } : {}),
      ...(method.discoveryUrl ? { discoveryUrl: method.discoveryUrl } : {}),
      ...(method.issuer ? { issuer: method.issuer } : {}),
      ...(method.requireIssuerValidation !== undefined
        ? { requireIssuerValidation: method.requireIssuerValidation }
        : {}),
      ...(method.authorizationUrl ? { authorizationUrl: method.authorizationUrl } : {}),
      ...(method.tokenUrl ? { tokenUrl: method.tokenUrl } : {}),
      ...(method.userInfoUrl ? { userInfoUrl: method.userInfoUrl } : {}),
      ...(method.scopes ? { scopes: [...method.scopes] } : {}),
      ...(method.redirectURI ? { redirectURI: method.redirectURI } : {}),
      ...(method.pkce !== undefined ? { pkce: method.pkce } : {}),
      ...(method.authentication ? { authentication: method.authentication } : {}),
      ...(method.prompt ? { prompt: method.prompt } : {}),
      ...(method.mapProfileToUser
        ? { mapProfileToUser: method.mapProfileToUser as GenericOAuthConfig["mapProfileToUser"] }
        : {}),
      ...(method.resource
        ? {
            resource: method.resource,
            authorizationUrlParams: { resource: method.resource },
            tokenUrlParams: { resource: method.resource },
          }
        : {}),
    });
  }
  return out;
}

/**
 * First tag off `Accept-Language`, quality values ignored. Locale
 * contract lives in `EmailSender.ts`.
 */
/** @internal exported for unit tests; not part of the public API. */
export function pickLocale(req: Request | undefined, fallback: string): string {
  const header = req?.headers.get("accept-language");
  if (!header) return fallback;
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  return first && first.length > 0 ? first : fallback;
}

// Magic-link defaults override Better Auth's tighter built-ins:
//   - 900s (15 min) link TTL — corporate mail (Outlook + Exchange,
//     Mimecast, Proofpoint URL Defense) often has 30-60s delivery
//     lag and users batch-check; 300s shipped too many "expired"
//     receipts. Industry baseline: Slack 60min, Notion / Vercel
//     24h. We split the difference and let adopters override.
//   - 3 allowed verification attempts — mail prefetchers (Outlook
//     Safe Links, Mimecast URL Protect, Proofpoint URL Defense)
//     routinely consume URLs once before the user opens the email.
//     1 attempt is genuinely broken on those inboxes.
const MAGIC_LINK_DEFAULT_EXPIRES_SECONDS = 900;
const MAGIC_LINK_DEFAULT_ALLOWED_ATTEMPTS = 3;

function buildMagicLinkPlugin(method: Extract<AuthMethodConfig, { kind: "magic-link" }>) {
  const fallback = method.fallbackLocale ?? "en";
  return magicLink({
    expiresIn: method.expiresInSeconds ?? MAGIC_LINK_DEFAULT_EXPIRES_SECONDS,
    allowedAttempts: method.allowedAttempts ?? MAGIC_LINK_DEFAULT_ALLOWED_ATTEMPTS,
    // Returned synchronously — same fire-and-forget contract as
    // email-otp via `advanced.backgroundTasks.handler`. The body
    // carries the click-URL; SDK doesn't ship a template, the
    // sender can render plain text or richer HTML.
    sendMagicLink: (data, ctx) => {
      const locale = pickLocale(ctx?.request, fallback);
      return method.sender.send({
        to: data.email,
        subject: "Your sign-in link",
        text: `Click to sign in: ${data.url}\nThe link expires shortly. If you didn't request this, ignore this email.`,
        locale,
        category: "auth.magic-link.sign-in",
      });
    },
  });
}

function buildEmailOTPPlugin(method: Extract<AuthMethodConfig, { kind: "email-otp" }>) {
  const fallback = method.fallbackLocale ?? "en";
  return emailOTP({
    ...(method.otpLength !== undefined ? { otpLength: method.otpLength } : {}),
    ...(method.expiresInSeconds !== undefined
      ? { expiresIn: method.expiresInSeconds }
      : {}),
    ...(method.allowedAttempts !== undefined
      ? { allowedAttempts: method.allowedAttempts }
      : {}),
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
        subject: `Your sign-in code: ${data.otp}`,
        text: `Your one-time code is ${data.otp}. It expires shortly. If you didn't request this, ignore this email.`,
        locale,
        category: `auth.email-otp.${data.type}`,
      });
    },
  });
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
/** @internal exported for unit tests; not part of the public API. */
export function validateBootstrap(
  rule: BootstrapOwnerRule,
  methods: ReadonlyArray<AuthMethodConfig>,
): void {
  if (rule.match === "github-login") {
    const hasGithub = methods.some(
      (method) =>
        (method.kind === "social" && method.provider === "github") ||
        (method.kind === "oauth" && method.providerId === "github"),
    );
    if (!hasGithub) {
      throw new Error(
        "createAuth: bootstrapOwner.match='github-login' but no GitHub provider is registered. " +
          "Register social GitHub or a trusted OAuth providerId='github', or switch to email matching.",
      );
    }
  }
}

/** @internal exported for unit tests; not part of the public API. */
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

/** @internal Keep provider-owned GitHub logins off user-controlled auth paths. */
export function guardGithubLoginProfile(
  user: Readonly<Record<string, unknown>>,
  context: AuthHookContext,
  methods: ReadonlyArray<AuthMethodConfig>,
): { readonly data: { readonly githubLogin: null } } | undefined {
  if (!("githubLogin" in user)) return undefined;
  const providerId = context?.path === "/callback/:id"
    ? context.params?.id
    : context?.path === "/oauth2/callback/:providerId"
      ? context.params?.providerId
      : null;
  const trusted = typeof providerId === "string" && methods.some((method) =>
    method.kind === "social"
      ? context?.path === "/callback/:id" && method.provider === "github" && providerId === "github"
      : method.kind === "oauth" &&
        context?.path === "/oauth2/callback/:providerId" &&
        method.providerId === providerId &&
        Boolean(method.mapProfileToUser),
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
      `createAuth: more than one \`${kind}\` method registered. Combine into one.`,
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

/**
 * Better Auth 1.6.x declares generic-OAuth URL parameter options but
 * its provider implementation does not replay them across every token
 * lifecycle step. Patch only resource-configured generic providers at
 * the provider boundary, using Better Auth's public OAuth helpers.
 */
/** @internal exported for lifecycle regression tests. */
export function buildOAuthResourceLifecyclePlugin(
  methods: ReadonlyArray<AuthMethodConfig>,
): BetterAuthPlugin | null {
  const configured = new Map(
    methods
      .filter(
        (method): method is Extract<AuthMethodConfig, { kind: "oauth" }> =>
          method.kind === "oauth" && typeof method.resource === "string",
      )
      .map((method) => [method.providerId, method] as const),
  );
  if (configured.size === 0) return null;

  return {
    id: "mantle-oauth-resource-lifecycle",
    init(ctx) {
      const tokenEndpoints = new Map<string, Promise<string>>();
      const resolveTokenEndpoint = (
        method: Extract<AuthMethodConfig, { kind: "oauth" }>,
      ): Promise<string> => {
        if (method.tokenUrl) return Promise.resolve(method.tokenUrl);
        const existing = tokenEndpoints.get(method.providerId);
        if (existing) return existing;
        const pending = (async () => {
          if (!method.discoveryUrl) {
            throw new Error(
              `OAuth provider '${method.providerId}' has no token endpoint.`,
            );
          }
          const response = await fetch(method.discoveryUrl, {
            headers: { accept: "application/json" },
            redirect: "error",
          });
          if (!response.ok) {
            throw new Error(
              `OAuth discovery for '${method.providerId}' returned ${response.status}.`,
            );
          }
          const discovery = (await response.json()) as { token_endpoint?: unknown };
          if (typeof discovery.token_endpoint !== "string") {
            throw new Error(
              `OAuth discovery for '${method.providerId}' omitted token_endpoint.`,
            );
          }
          return discovery.token_endpoint;
        })();
        tokenEndpoints.set(method.providerId, pending);
        return pending;
      };

      return {
        context: {
          socialProviders: ctx.socialProviders.map((provider) => {
            const method = configured.get(provider.id);
            if (!method?.resource) return provider;
            const createAuthorizationURL = provider.createAuthorizationURL.bind(provider);
            return {
              ...provider,
              async createAuthorizationURL(data) {
                const url = await createAuthorizationURL(data);
                url.searchParams.set("resource", method.resource!);
                return url;
              },
              async validateAuthorizationCode(data) {
                const tokens = await validateAuthorizationCode({
                  code: data.code,
                  codeVerifier: data.codeVerifier,
                  redirectURI: data.redirectURI,
                  options: {
                    clientId: method.clientId,
                    clientSecret: method.clientSecret,
                    redirectURI: method.redirectURI,
                  },
                  tokenEndpoint: await resolveTokenEndpoint(method),
                  authentication: method.authentication,
                  resource: method.resource,
                });
                return applyDefaultAccessTokenExpiry(tokens, undefined);
              },
              async refreshAccessToken(refreshTokenValue: string) {
                const tokens = await refreshAccessToken({
                  refreshToken: refreshTokenValue,
                  options: {
                    clientId: method.clientId,
                    clientSecret: method.clientSecret,
                  },
                  tokenEndpoint: await resolveTokenEndpoint(method),
                  authentication: method.authentication,
                  extraParams: { resource: method.resource! },
                });
                return applyDefaultAccessTokenExpiry(tokens, undefined);
              },
            };
          }),
        },
      };
    },
  };
}

/** @internal exported for provider-option mapping tests. */
export function buildOAuthProviderOptions(
  config: OAuthProviderConfig,
): Parameters<typeof oauthProvider>[0] {
  return {
    loginPage: config.loginPage,
    consentPage: config.consentPage,
    ...(config.scopes ? { scopes: [...config.scopes] } : {}),
    ...(config.validAudiences
      ? { validAudiences: [...config.validAudiences] }
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

function buildAuth(config: CreateAuthConfig) {
  if (config.methods.length === 0) {
    throw new Error(
      "createAuth: methods[] is empty — register at least one AuthMethodConfig so staff can sign in.",
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
  const resourceLifecyclePlugin = buildOAuthResourceLifecyclePlugin(config.methods);

  // Rate limit: Better Auth's per-route limits gate on
  // `process.env.NODE_ENV === "production"`, which is unset on
  // Cloudflare Workers — leaving the limits silently off. When any
  // email-shaped method is wired (free email-send-to-any-address
  // surface) we ALWAYS turn limits on; adopter can override
  // window/max via `config.rateLimit`.
  const hasEmailMethod = !!(emailOtpMethod || magicLinkMethod);
  const rateLimitDefault = hasEmailMethod
    ? { window: 60, max: 10, enabled: true as const }
    : null;
  const rateLimit = config.rateLimit
    ? { ...config.rateLimit, enabled: true as const }
    : rateLimitDefault;

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
            config: genericOAuthProviders.map(
              ({ displayName: _displayName, ...provider }) => provider,
            ),
          }),
        ]
      : []),
    ...(resourceLifecyclePlugin ? [resourceLifecyclePlugin] : []),
    ...(emailOtpMethod ? [buildEmailOTPPlugin(emailOtpMethod)] : []),
    ...(magicLinkMethod ? [buildMagicLinkPlugin(magicLinkMethod)] : []),
    ...(config.oauthProvider
      ? [
          jwt(),
          oauthProvider(buildOAuthProviderOptions(config.oauthProvider)),
        ]
      : []),
  ];

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
    // statement runs as one D1 op, so two concurrent first signups
    // can't both win: the loser's UPDATE finds a staff user in the
    // subquery and silently writes zero rows.
    const placeholders = STAFF_ROLES.map(() => "?").join(",");
    const result = await config.database
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
  const databaseHooks = {
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
  };

  return betterAuth({
    database: config.database,
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: normalizeAuthBasePath(config.basePath),
    onAPIError: { errorURL: normalizeAuthErrorURL(config.errorURL, config.baseURL) },
    socialProviders,
    user: userConfig,
    ...(rateLimit ? { rateLimit } : {}),
    trustedOrigins,
    advanced: advancedConfig,
    plugins: sdkPlugins,
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
      readonly reason: "invalid-token" | "insufficient-scope";
      readonly missingScopes?: readonly string[];
    };

// Better Auth's full inferred type pulls plugin internals
// (`AdminOptions`) that aren't re-exported, so emitting a .d.ts that
// names that type fails (TS4058). The structural facade keeps the
// public surface stable.
export interface Auth {
  readonly basePath: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (request: Request) => Promise<{
    session: { id: string; userId: string; expiresAt: Date };
    user: {
      id: string;
      email: string;
      name: string;
      image?: string | null;
      role?: string | null;
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
   *  JWKS. Opaque tokens and remote introspection are intentionally not
   *  supported. */
  readonly verifyOAuthAccessToken: (
    tokenOrRequest: string | Request,
    options: {
      readonly audience: string;
      readonly scopes?: readonly string[];
    },
  ) => Promise<OAuthAccessTokenVerification>;
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

const SETUP_INCOMPLETE_AUTHS = new WeakSet<Auth>();

/** True only for the fail-closed facade returned by createSetupIncompleteAuth. */
export function isSetupIncompleteAuth(auth: Auth): boolean {
  return SETUP_INCOMPLETE_AUTHS.has(auth);
}

export function createAuth(config: CreateAuthConfig): Auth {
  const auth = buildAuth(config);
  const basePath = normalizeAuthBasePath(config.basePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = auth.api as any;
  const localJwksCacheKey = {};
  const verifyAccessToken = config.oauthProvider
    ? async (token: string, audience: string) => {
        const context = await auth.$context;
        return verifyOAuthJwtWithLocalJwks(
          token,
          audience,
          context.baseURL,
          async () => api.getJwks(),
          localJwksCacheKey,
        );
      }
    : null;
  return {
    basePath,
    handler: async (request) =>
      normalizeAuthResponseCookies(await auth.handler(request)),
    getSession: (request) =>
      api.getSession({ headers: request.headers }).then((r: unknown) => r ?? null),
    getUserRole: async (userId) => {
      const row = await config.database
        .prepare("SELECT role FROM user WHERE id = ? LIMIT 1")
        .bind(userId)
        .first<{ role: string | null }>();
      return row?.role ?? null;
    },
    getUser: async (userId) => {
      const row = await config.database
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
    getProviderAccessToken: (request, providerId) =>
      getProviderAccessTokenForRequest(api, request, providerId),
    verifyOAuthAccessToken: async (tokenOrRequest, options) => {
      return verifyOAuthJwt(
        tokenOrRequest,
        options,
        verifyAccessToken,
      );
    },
    methods: config.methods.map<AuthMethodInfo>((m) => {
      switch (m.kind) {
        case "social":
          return { kind: "social", provider: m.provider };
        case "oauth":
          return {
            kind: "oauth",
            providerId: m.providerId,
            ...(m.displayName ? { displayName: m.displayName } : {}),
          };
        case "email-otp":
        case "magic-link":
          return { kind: m.kind };
      }
    }),
    listLinkedAccounts: async (userId) => {
      const result = await config.database
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
      return (result.results ?? []).map((row) => ({
        id: row.id,
        providerId: row.providerId,
        accountId: row.accountId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    },
    unlinkAccount: async (userId, providerId) => {
      const result = await config.database
        .prepare("DELETE FROM account WHERE userId = ? AND providerId = ?")
        .bind(userId, providerId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },
    listUsers: async () => {
      const placeholders = STAFF_ROLES.map(() => "?").join(",");
      const result = await config.database
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
      return (result.results ?? []).map((row) => ({
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
      const parsedCursor = cursor ? decodeMemberCursor(cursor) : null;
      const backward = cursorDirection === "backward";
      const conditions = [
        `(role IS NULL OR role NOT IN (${STAFF_ROLES.map(() => "?").join(",")}))`,
      ];
      const bindings: unknown[] = [...STAFF_ROLES];
      const term = search?.trim().toLowerCase();
      if (term) {
        conditions.push("(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')");
        const like = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
        bindings.push(like, like);
      }
      if (parsedCursor) {
        const operator = backward ? "<" : ">";
        conditions.push(`(createdAt ${operator} ? OR (createdAt = ? AND id ${operator} ?))`);
        bindings.push(parsedCursor[0], parsedCursor[0], parsedCursor[1]);
      }
      bindings.push(limit + 1);
      const result = await config.database
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
      const rows = (result.results ?? []).slice(0, limit);
      if (backward) rows.reverse();
      const items = rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: row.emailVerified !== 0,
        createdAt: new Date(row.createdAt),
      }));
      const hasMore = (result.results?.length ?? 0) > limit;
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
      const result = await config.database
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
      const normalized = email.trim().toLowerCase();
      const existing = await config.database
        .prepare("SELECT id FROM user WHERE email = ? LIMIT 1")
        .bind(normalized)
        .first<{ id: string }>();
      if (existing) return { kind: "exists", id: existing.id };
      const id = generateUserId();
      const now = new Date().toISOString();
      // `name` defaults to the address's local part — Better Auth
      // requires NOT NULL, and the invitee's real display name arrives
      // with their first sign-in (social) or stays editable later.
      await config.database
        .prepare(
          "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(id, normalized.split("@")[0] ?? normalized, normalized, now, now, role)
        .run();
      return { kind: "created", id };
    },
    revokeInvite: async (userId) => {
      const result = await config.database
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
          ...(input.type ? { type: input.type } : {}),
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
): Auth {
  const basePath = normalizeAuthBasePath(options.basePath);
  const message = options.message ?? "Auth is not configured yet.";
  const response =
    options.response ??
    (() =>
      Response.json(
        { error: "setup_incomplete", message },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      ));
  const auth: Auth = {
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

function bearerTokenFrom(tokenOrRequest: string | Request): string | null {
  if (typeof tokenOrRequest === "string") return tokenOrRequest.trim() || null;
  const header = tokenOrRequest.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** @internal exported to pin the session-bound Better Auth request and
 *  secret-minimizing response mapping. */
export async function getProviderAccessTokenForRequest(
  api: {
    getAccessToken(input: {
      headers: Headers;
      body: { providerId: string };
    }): Promise<unknown>;
  },
  request: Request,
  providerId: string,
): Promise<ProviderAccessToken> {
  const value = (await api.getAccessToken({
    headers: request.headers,
    body: { providerId },
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

type LocalJwksFetcher = Exclude<
  Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
  string
>;

/** @internal exported to keep same-Worker OAuth verification off the network. */
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

/** @internal exported to pin the stable facade's normalization and
 *  401/403 contract independently of Better Auth network/JWKS I/O. */
export async function verifyOAuthJwt(
  tokenOrRequest: string | Request,
  options: {
    readonly audience: string;
    readonly scopes?: readonly string[];
  },
  verify: ((token: string, audience: string) => Promise<Record<string, unknown>>) | null,
): Promise<OAuthAccessTokenVerification> {
  const token = bearerTokenFrom(tokenOrRequest);
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
  } catch {
    return { ok: false, status: 401, reason: "invalid-token" };
  }
}

/** @internal exported to pin secret-minimizing DCR response mapping. */
export function mapRegisteredOAuthClient(value: unknown): RegisteredOAuthClient {
  const row = value as {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
    scope?: string;
    client_name?: string;
    client_uri?: string;
    token_endpoint_auth_method?: string;
    type?: string;
    public?: boolean;
  };
  if (!row.client_id || !Array.isArray(row.redirect_uris)) {
    throw new Error("registerOAuthClient: Better Auth returned an invalid client.");
  }
  return {
    clientId: row.client_id,
    ...(row.client_secret && row.public !== true && row.token_endpoint_auth_method !== "none"
      ? { clientSecret: row.client_secret }
      : {}),
    redirectUris: row.redirect_uris,
    ...(row.scope ? { scope: row.scope.split(" ").filter(Boolean) } : {}),
    ...(row.client_name ? { clientName: row.client_name } : {}),
    ...(row.client_uri ? { clientUri: row.client_uri } : {}),
    ...(row.token_endpoint_auth_method
      ? { tokenEndpointAuthMethod: row.token_endpoint_auth_method }
      : {}),
    ...(row.type ? { type: row.type } : {}),
    ...(row.public !== undefined ? { public: row.public } : {}),
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
