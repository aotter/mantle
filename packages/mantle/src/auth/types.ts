/** The auth contract: options for `createMantleAuth`, its sign-in methods, and the `MantleAuth` facade. */
import type { OAuthProviderExtension, Scope } from "@better-auth/oauth-provider";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import type { EmailOTPOptions, GenericOAuthConfig, MagicLinkOptions } from "better-auth/plugins";
import type { SocialProviders } from "better-auth/social-providers";
import { decodeMemberCursor, encodeMemberCursor, type OAuthConsentInfo, type OAuthConsentRequest } from "../admin/consent.js";
import type { AuthUserInfo, InviteUserResult, ListMembersArgs, MemberListResult, StaffUserInfo } from "../admin/identity.js";
import type { DatabaseDriver, EmailSender } from "../core/index.js";
import { STAFF_ROLES, type StaffRole } from "../spec/domain/index.js";

export type { OAuthProviderExtension } from "@better-auth/oauth-provider";
export type { AuthUserInfo, InviteUserResult, ListMembersArgs, MemberListResult, MemberUserInfo, StaffUserInfo } from "../admin/identity.js";


export type BackgroundTaskRetainer = (promise: Promise<unknown>) => void;

/** Per-request platform hooks a host passes into `MantleAuth.handler`. */
export interface MantleAuthRequestContext {
  /** Keeps Better Auth background work alive past the response, e.g. `ctx.waitUntil`. */
  readonly waitUntil?: BackgroundTaskRetainer;
}


export type { OAuthConsentInfo, OAuthConsentRequest } from "../admin/consent.js";
export { decodeMemberCursor,encodeMemberCursor,STAFF_ROLES,type StaffRole };
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
  /** Additional `@better-auth/oauth-provider` extensions (token grants,
   *  client authentication, metadata, claims). On the `mcpResource` branch
   *  they follow Core's own claims extension; on the plain provider branch
   *  they are the whole list. Core never inspects them. This is the seam for MCP
   *  Enterprise-Managed Authorization: an ID-JAG extension such as
   *  `@aotterclam/id-jag` plugs in here with the adopter's issuer and JWKS. */
  readonly extensions?: ReadonlyArray<OAuthProviderExtension>;
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
  readonly requestHeaders: ConstructorParameters<typeof Headers>[0];
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
   * SQLite and PostgreSQL are supported; the host supplies a native Better Auth
   * database handle and Mantle driver over the same connection store. The two
   * handles must wrap one underlying store — splitting them splits
   * schema migration from Better Auth's own reads.
   */
  readonly database: NonNullable<BetterAuthOptions["database"]>;
  /** Mantle's port over that same store. Carries this package's own SQL and the
   * Better Auth schema migration. */
  readonly driver: DatabaseDriver;
  /** Optional derivative session storage. The Mantle store must be prepared
   * before cached Auth operations so keys can bind to its instance identity. */
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
  /** Forwarded to Better Auth's `account.accountLinking`. Omitted here,
   *  Better Auth's own defaults apply: implicit linking is ON, so a social
   *  sign-in whose provider reports a verified email lands on the existing
   *  row with that email instead of creating a second one, and
   *  `requireLocalEmailVerified` keeps that from happening while the local
   *  row is still unverified. Set this to scope linking — `enabled: false`
   *  or `disableImplicitLinking` to refuse it, `trustedProviders` to accept
   *  a provider's word without `email_verified` (it does not bypass
   *  `requireLocalEmailVerified`). Listing a provider asserts it verifies
   *  the addresses it returns. */
  readonly accountLinking?: NonNullable<
    NonNullable<BetterAuthOptions["account"]>["accountLinking"]
  >;
  /**
   * Host-trusted ingress headers used as Better Auth's rate-limit identity.
   * Required and fail-closed: empty or missing refuses to boot. Pass only
   * headers the host overwrites at the edge. Never default to
   * client-controlled `X-Forwarded-For`. Cloudflare `createAuth` supplies
   * `cf-connecting-ip`; Bun and Vercel hosts must pass their own header(s).
   */
  readonly ipAddressHeaders: ReadonlyArray<string>;
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
  /** Serve one Better Auth request. Pass `waitUntil` so background work
   *  (OTP send, rate-limit cleanup) survives the response on Workers. */
  readonly handler: (request: Request, context?: MantleAuthRequestContext) => Promise<Response>;
  readonly getSession: (request: Request) => Promise<{
    /** `createdAt` is when this sign-in happened: a sensitive action can require a recent one. */
    session: { id: string; userId: string; expiresAt: Date; createdAt: Date };
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
  readonly listUsers: (request: Request) => Promise<readonly StaffUserInfo[]>;
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
    request: Request,
    userId: string,
    role: StaffRole | null,
  ) => Promise<boolean>;
  /** Invite a staff member by email: pre-create the user row
   *  (`emailVerified: 0`) with the role already assigned, so the
   *  invitee's FIRST sign-in with that email lands with the role in
   *  effect — no second assignment step. Magic-link / email-OTP
   *  sign-ins match the row by email. A social sign-in does NOT: the
   *  row is unverified, and Better Auth's `requireLocalEmailVerified`
   *  defaults to on, so linking is refused with `account not linked`
   *  regardless of `accountLinking.trustedProviders` (unless the adopter
   *  sets `accountLinking.requireLocalEmailVerified: false`) — an invitee
   *  whose only credential is a social provider must verify by email once
   *  before that provider attaches. Email is normalized (trim +
   *  lowercase). Returns `exists` instead of throwing when the email
   *  already has a row. */
  readonly inviteUser: (
    request: Request,
    email: string,
    role: StaffRole,
  ) => Promise<InviteUserResult>;
  readonly sendStaffInvitation?: (email: string, role: StaffRole) => Promise<void>;
  /** Delete an invitation row. Guarded to rows nobody ever signed in
   *  to (`emailVerified = 0` AND no linked `account` row) so a real
   *  user with sessions/accounts can never be cascade-deleted through
   *  this path. Returns false when the row didn't match the guard. */
  readonly revokeInvite: (userId: string) => Promise<boolean>;
  /** Delete a user; sessions and accounts cascade, and cached sessions are cleared when a session cache is configured. Pending email codes for its address are deleted too. A service stops running raw SQL against auth tables. */
  readonly deleteUser: (userId: string) => Promise<boolean>;
  /** Register an OAuth/OIDC client when `oauthProvider` is configured.
   *  Uses Better Auth's own provider plugin endpoint and returns the
   *  client secret only on creation. The caller must pass the current
   *  owner/admin request headers so Better Auth can enforce privileges. */
  readonly registerOAuthClient: (
    input: RegisterOAuthClientInput,
  ) => Promise<RegisteredOAuthClient>;
}

