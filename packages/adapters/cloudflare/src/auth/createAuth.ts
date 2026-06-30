import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, emailOTP, jwt, magicLink } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { oauthProvider, type Scope } from "@better-auth/oauth-provider";
import type { EmailSender } from "@aotter/mantle-runtime";
import { STAFF_ROLES, type StaffRole } from "@aotter/mantle-spec";

export { STAFF_ROLES, type StaffRole };
/**
 * Set lookup for "is this role string a staff role?" — handlers/MCP
 * gating reach for this every request, so the Set form is worth the
 * one-time allocation over `STAFF_ROLES.includes(x)`.
 */
export const STAFF_ROLE_SET: ReadonlySet<string> = new Set(STAFF_ROLES);

/**
 * Provider id for the `kind: "social"` method. Mirrors Better Auth's
 * own `socialProviders` block keys for 1.6.9. Adding a provider that
 * Better Auth supports = adding its id here; no other wiring needed
 * (the config flows through to Better Auth as-is, plus the per-
 * provider i18n label).
 */
export type SocialProviderId =
  | "github"
  | "google"
  | "apple"
  | "microsoft-entra-id"
  | "facebook"
  | "discord"
  | "twitter"
  | "linkedin"
  | "spotify"
  | "twitch"
  | "gitlab"
  | "tiktok"
  | "reddit"
  | "kick"
  | "vk"
  | "naver"
  | "kakao"
  | "line"
  | "slack"
  | "atlassian"
  | "zoom"
  | "notion"
  | "figma"
  | "linear"
  | "vercel"
  | "paypal"
  | "huggingface"
  | "cognito"
  | "salesforce"
  | "polar"
  | "railway"
  | "roblox"
  | "paybin"
  | "wechat"
  | "dropbox";

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

/**
 * Account-linking policy forwarded verbatim to Better Auth's
 * `account.accountLinking`. All fields optional — omitted keys fall
 * back to Better Auth's defaults (`enabled: true`,
 * `allowDifferentEmails: false`, `trustedProviders: []`,
 * `updateUserInfoOnLink: false`).
 *
 * Trusted providers bypass email-verification before linking — only
 * use when the upstream IDP guarantees a verified email (Google /
 * Apple / GitHub). `allowDifferentEmails: true` weakens the default
 * email-match guard and meaningfully widens the takeover surface;
 * default to false unless you have a specific use case (e.g. a
 * provider that doesn't return email at all).
 *
 * Better Auth does NOT merge two pre-existing user rows; this config
 * controls behavior at sign-in / link time, not after-the-fact
 * reconciliation. See Better Auth issues #6126 / #2062 for the
 * upstream stance.
 */
export interface AccountLinkingConfig {
  readonly enabled?: boolean;
  readonly trustedProviders?: ReadonlyArray<SocialProviderId>;
  readonly allowDifferentEmails?: boolean;
  readonly updateUserInfoOnLink?: boolean;
}

/**
 * Session policy forwarded to Better Auth's `session` config. All
 * fields optional. `expiresIn` controls absolute session lifetime
 * (Better Auth default 7 days). `updateAge` is the sliding-renewal
 * window — sessions whose age exceeds `updateAge` get their expiry
 * extended on the next request (Better Auth default 1 day). All
 * values in seconds.
 *
 * `cookieCache.enabled: true` lets Better Auth attach a short-TTL
 * signed cookie carrying the session row so `getSession` can skip
 * the D1 read on every request; `maxAge` caps that cache (Better
 * Auth default 5 minutes). Use with care — invalidating a session
 * via `signOut` doesn't clear cached copies in flight.
 */
export interface SessionConfig {
  readonly expiresIn?: number;
  readonly updateAge?: number;
  readonly cookieCache?: {
    readonly enabled: boolean;
    readonly maxAge?: number;
  };
}

/**
 * Email-verification policy forwarded to Better Auth's
 * `emailVerification`. Decoupled from `email-otp` / `magic-link`
 * methods — this controls the verification-token flow that fires
 * separately when Better Auth has a `sendVerificationEmail` callback
 * configured. All optional; omitted keys use Better Auth's defaults.
 *
 * **`sendOnSignUp` only delivers mail when a `sendVerificationEmail`
 * callback is wired into Better Auth.** This config does NOT expose
 * that callback — adopters who flip `sendOnSignUp: true` without
 * providing a sender will see the flag set in Better Auth but no
 * email leaves the worker. Wiring the callback is a follow-up SDK
 * surface; for now the flag is useful for the
 * `autoSignInAfterVerification` knob and forward-compat.
 */
export interface EmailVerificationConfig {
  readonly sendOnSignUp?: boolean;
  readonly autoSignInAfterVerification?: boolean;
  readonly expiresIn?: number;
}

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
  readonly allowPublicClientPrelogin?: boolean;
  readonly clientRegistrationDefaultScopes?: ReadonlyArray<Scope>;
  readonly clientRegistrationAllowedScopes?: ReadonlyArray<Scope>;
  readonly accessTokenExpiresIn?: number;
  readonly idTokenExpiresIn?: number;
  readonly refreshTokenExpiresIn?: number;
  readonly cachedTrustedClients?: ReadonlySet<string>;
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
  readonly secret: string;
  /** Registered auth methods. Boot fails fast if empty. */
  readonly methods: ReadonlyArray<AuthMethodConfig>;
  /** First-user-becomes-owner rule. Without it, the `owner` role must
   *  be assigned manually in D1. */
  readonly bootstrapOwner?: BootstrapOwnerRule;
  /** Better Auth's built-in rate limit. Defaults off; production
   *  deployments should set it. */
  readonly rateLimit?: { readonly window: number; readonly max: number };
  /** Forwarded to Better Auth's `account.accountLinking`. Omit for
   *  Better Auth's defaults (linking enabled, same-email required). */
  readonly accountLinking?: AccountLinkingConfig;
  /** Forwarded to Better Auth's `session`. Omit for Better Auth's
   *  defaults (7 day expiry, 1 day update age, no cookie cache). */
  readonly session?: SessionConfig;
  /** Forwarded to Better Auth's `emailVerification`. Omit for Better
   *  Auth's defaults. */
  readonly emailVerification?: EmailVerificationConfig;
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
}> {
  const seenProviderIds = new Set<string>();
  const out: ReturnType<typeof buildGenericOAuthProviders> = [];
  for (const method of methods) {
    if (method.kind !== "oauth") continue;
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
 * `match: "github-login"` with no `github` method registered. Throws
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
      (m) => m.kind === "social" && m.provider === "github",
    );
    if (!hasGithub) {
      throw new Error(
        "createAuth: bootstrapOwner.match='github-login' but no `social` method with provider='github' is registered. " +
          "Either register a github social method or switch to `bootstrapOwner: { match: 'email', value: '…' }`.",
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
    ...(emailOtpMethod ? [buildEmailOTPPlugin(emailOtpMethod)] : []),
    ...(magicLinkMethod ? [buildMagicLinkPlugin(magicLinkMethod)] : []),
    ...(config.oauthProvider
      ? [
          jwt(),
          oauthProvider({
            loginPage: config.oauthProvider.loginPage,
            consentPage: config.oauthProvider.consentPage,
            ...(config.oauthProvider.scopes
              ? { scopes: [...config.oauthProvider.scopes] }
              : {}),
            ...(config.oauthProvider.allowDynamicClientRegistration !== undefined
              ? {
                  allowDynamicClientRegistration:
                    config.oauthProvider.allowDynamicClientRegistration,
                }
              : {}),
            ...(config.oauthProvider.allowUnauthenticatedClientRegistration !== undefined
              ? {
                  allowUnauthenticatedClientRegistration:
                    config.oauthProvider.allowUnauthenticatedClientRegistration,
                }
              : {}),
            ...(config.oauthProvider.allowPublicClientPrelogin !== undefined
              ? {
                  allowPublicClientPrelogin:
                    config.oauthProvider.allowPublicClientPrelogin,
                }
              : {}),
            ...(config.oauthProvider.clientRegistrationDefaultScopes
              ? {
                  clientRegistrationDefaultScopes: [
                    ...config.oauthProvider.clientRegistrationDefaultScopes,
                  ],
                }
              : {}),
            ...(config.oauthProvider.clientRegistrationAllowedScopes
              ? {
                  clientRegistrationAllowedScopes: [
                    ...config.oauthProvider.clientRegistrationAllowedScopes,
                  ],
                }
              : {}),
            ...(config.oauthProvider.accessTokenExpiresIn !== undefined
              ? { accessTokenExpiresIn: config.oauthProvider.accessTokenExpiresIn }
              : {}),
            ...(config.oauthProvider.idTokenExpiresIn !== undefined
              ? { idTokenExpiresIn: config.oauthProvider.idTokenExpiresIn }
              : {}),
            ...(config.oauthProvider.refreshTokenExpiresIn !== undefined
              ? { refreshTokenExpiresIn: config.oauthProvider.refreshTokenExpiresIn }
              : {}),
            ...(config.oauthProvider.cachedTrustedClients
              ? {
                  cachedTrustedClients: new Set(
                    config.oauthProvider.cachedTrustedClients,
                  ),
                }
              : {}),
            ...(config.oauthProvider.clientPrivileges
              ? { clientPrivileges: config.oauthProvider.clientPrivileges }
              : {}),
          }),
        ]
      : []),
  ];

  // `user.additionalFields`: SDK owns `githubLogin` only.
  const userConfig = {
    additionalFields: {
      githubLogin: {
        type: "string" as const,
        required: false,
        input: false,
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
      create: { after: sdkUserCreateAfter },
    },
  };

  // Forward adopter-supplied optional Better Auth config. We do NOT
  // first-class every BA option — only the ones adopters routinely
  // need (account-linking policy, session lifetime, email-verification
  // behavior). Omitted keys flow through to Better Auth defaults.
  const accountConfig = config.accountLinking
    ? {
        account: {
          accountLinking: {
            ...(config.accountLinking.enabled !== undefined
              ? { enabled: config.accountLinking.enabled }
              : {}),
            ...(config.accountLinking.trustedProviders
              ? { trustedProviders: [...config.accountLinking.trustedProviders] }
              : {}),
            ...(config.accountLinking.allowDifferentEmails !== undefined
              ? { allowDifferentEmails: config.accountLinking.allowDifferentEmails }
              : {}),
            ...(config.accountLinking.updateUserInfoOnLink !== undefined
              ? { updateUserInfoOnLink: config.accountLinking.updateUserInfoOnLink }
              : {}),
          },
        },
      }
    : {};
  const sessionConfig = config.session
    ? {
        session: {
          ...(config.session.expiresIn !== undefined
            ? { expiresIn: config.session.expiresIn }
            : {}),
          ...(config.session.updateAge !== undefined
            ? { updateAge: config.session.updateAge }
            : {}),
          ...(config.session.cookieCache
            ? {
                cookieCache: {
                  enabled: config.session.cookieCache.enabled,
                  ...(config.session.cookieCache.maxAge !== undefined
                    ? { maxAge: config.session.cookieCache.maxAge }
                    : {}),
                },
              }
            : {}),
        },
      }
    : {};
  const emailVerificationConfig = config.emailVerification
    ? {
        emailVerification: {
          ...(config.emailVerification.sendOnSignUp !== undefined
            ? { sendOnSignUp: config.emailVerification.sendOnSignUp }
            : {}),
          ...(config.emailVerification.autoSignInAfterVerification !== undefined
            ? {
                autoSignInAfterVerification:
                  config.emailVerification.autoSignInAfterVerification,
              }
            : {}),
          ...(config.emailVerification.expiresIn !== undefined
            ? { expiresIn: config.emailVerification.expiresIn }
            : {}),
        },
      }
    : {};

  return betterAuth({
    database: config.database,
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: normalizeAuthBasePath(config.basePath),
    socialProviders,
    user: userConfig,
    ...(rateLimit ? { rateLimit } : {}),
    ...accountConfig,
    ...sessionConfig,
    ...emailVerificationConfig,
    trustedOrigins,
    advanced: advancedConfig,
    plugins: sdkPlugins,
    databaseHooks,
  });
}

/**
 * Method kind exposed to clients. Mirrors `AuthMethodConfig["kind"]`
 * but without the adapter-internal config (secrets, sender refs). The
 * admin SPA reads this to decide which sign-in sections to render.
 */
export type AuthMethodKind = AuthMethodConfig["kind"];

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
 * `emailVerified: false` + a `null` role is the resting state of an
 * *invitation* (a row pre-created by `inviteUser` that nobody has
 * signed in to yet) — the admin SPA renders those as "invited".
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

/** Result of `inviteUser`. `exists` carries the prior row's id so the
 *  caller can point the operator at the existing user instead of
 *  surfacing a bare failure. */
export type InviteUserResult =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "exists"; readonly id: string };

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
  /** Read `user.role` directly from D1. Bearer-token auth surfaces
   *  (MCP, HTTP Triggers) need this because OAuth access tokens carry
   *  userId + scopes but not the user's role. */
  readonly getUserRole: (userId: string) => Promise<string | null>;
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
  /** List every user row for the staff-management surface, ordered by
   *  `createdAt` ascending. Read-only — uses the underlying D1 binding
   *  directly. Owner-only enforcement is the mount layer's job
   *  (`/admin/api/staff`); this method does not gate. */
  readonly listUsers: () => Promise<readonly StaffUserInfo[]>;
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
   *  client secret only on creation, exactly like OAuth dynamic client
   *  registration. */
  readonly registerOAuthClient: (
    input: RegisterOAuthClientInput,
  ) => Promise<RegisteredOAuthClient>;
}

export function createAuth(config: CreateAuthConfig): Auth {
  const auth = buildAuth(config);
  const basePath = normalizeAuthBasePath(config.basePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = auth.api as any;
  return {
    basePath,
    handler: (request) => auth.handler(request),
    getSession: (request) =>
      api.getSession({ headers: request.headers }).then((r: unknown) => r ?? null),
    getUserRole: async (userId) => {
      const row = await config.database
        .prepare("SELECT role FROM user WHERE id = ? LIMIT 1")
        .bind(userId)
        .first<{ role: string | null }>();
      return row?.role ?? null;
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
      const result = await config.database
        .prepare(
          "SELECT id, email, name, role, githubLogin, emailVerified, createdAt FROM user ORDER BY createdAt ASC, id ASC",
        )
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
        headers: new Headers(),
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
        { status: 503, headers: { "cache-control": "no-store" } },
      ));
  return {
    basePath,
    handler: async () => response(),
    getSession: async () => null,
    getUserRole: async () => null,
    methods: [],
    listLinkedAccounts: async () => [],
    unlinkAccount: async () => false,
    listUsers: async () => [],
    setUserRole: async () => false,
    inviteUser: async () => {
      throw new Error(message);
    },
    revokeInvite: async () => false,
    registerOAuthClient: async () => {
      throw new Error(message);
    },
  };
}

function mapRegisteredOAuthClient(value: unknown): RegisteredOAuthClient {
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
    ...(row.client_secret ? { clientSecret: row.client_secret } : {}),
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
