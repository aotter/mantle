---
description: Configure MANTLE_AUTH_MODE, secrets, the first owner and staff roles; understand which routes need a session.
---
# Authentication

Conventional Auth is chosen by one variable, `MANTLE_AUTH_MODE`, and fails closed when its configuration is incomplete. This page covers the two modes, the secrets each needs, first-owner bootstrap, roles, the routes that require a session, and the Better Auth integration surface.

## Local Admin: email OTP

The generated CF app writes `.dev.vars.example`. Copy it to `.dev.vars` for
local use, then set `MANTLE_AUTH_MODE=local-otp`, the real `ADMIN_EMAIL`, a
random `BETTER_AUTH_SECRET`, and the exact loopback `PUBLIC_ORIGIN`. It configures
its email-OTP auth factory only for a
loopback origin. If you author the Worker yourself, pass `auth` to
`createMantleWorker` with `email-otp`, `ConsoleEmailSender`, and
`bootstrapOwner.match: "email"`; that factory does not read the conventional
mode matrix. The one-time code is printed in wrangler logs. See
[Quickstart: local Admin](../start/quickstart-admin.md). `ConsoleEmailSender`
is for `wrangler dev` only; production needs a real sender. Match
`PUBLIC_ORIGIN` to wrangler's actual `127.0.0.1:8787` origin or Better Auth
will reject OTP with `INVALID_ORIGIN`.

For production, the generated Worker's local OTP branch is disabled outside
loopback. Configure the conventional `self-managed` or `hosted` Auth mode,
including its required provider credentials and `ADMIN_GITHUB_LOGIN`, instead
of editing the CLI-owned Worker. An application that needs production email
delivery should author its own Worker Auth factory and real `EmailSender`.

With `auth` set, the mode matrix below is not read. Core still owns `/admin` and `/api/auth/*`.

For production email OTP in a manually authored Worker, keep the custom `createAuth()` factory, replace
`ConsoleEmailSender` with the application's production `EmailSender`, and keep
`bootstrapOwner: { match: "email", value: <owner email> }`. Store the sender
credentials and `BETTER_AUTH_SECRET` as Worker secrets. If the application has
no transactional-email provider, use self-managed GitHub OAuth instead; never
deploy console delivery.

## Mode matrix

| Mode | Non-secret vars | Worker secrets | Must be absent |
|---|---|---|---|
| `self-managed` | `MANTLE_AUTH_MODE=self-managed`, `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`, `ADMIN_GITHUB_LOGIN` | `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` | `MANTLE_HOSTED_AUTH_ISSUER`, `MANTLE_HOSTED_AUTH_CLIENT_ID` |
| `hosted` | `MANTLE_AUTH_MODE=hosted`, `PUBLIC_ORIGIN`, `MANTLE_HOSTED_AUTH_ISSUER`, `MANTLE_HOSTED_AUTH_CLIENT_ID`, `ADMIN_GITHUB_LOGIN` | `BETTER_AUTH_SECRET` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

Validation rules:

- `PUBLIC_ORIGIN` is the site's HTTPS origin without a trailing slash. When unset, the adapter falls back to `http://localhost:8787`. That fallback string is not the preferred local Admin pin. The origin wrangler prints is authoritative; the Admin OTP reference binds `127.0.0.1:8787` and sets `PUBLIC_ORIGIN` to the same origin.
- Self-managed uses the site's own GitHub OAuth app. Register its callback URL as `<PUBLIC_ORIGIN>/api/auth/callback/github`.
- Hosted is a public PKCE client with no client secret. `MANTLE_HOSTED_AUTH_ISSUER` must be an HTTPS root origin (no path, query or fragment; `http` only for loopback). `MANTLE_HOSTED_AUTH_CLIENT_ID` must be a URL on that same origin shaped `/clients/<id>`.
- `ADMIN_GITHUB_LOGIN` must be a valid GitHub login.

Any missing, invalid, partial or mixed-mode configuration produces a setup-incomplete Auth instance instead of a working one.

## `503 setup_incomplete`

With incomplete Auth, public routes keep working: public Views, public HTTP Triggers, public pages, `.md` mirrors, `llms.txt` and the sitemap. Auth-owned private routes return:

```json
{ "error": "setup_incomplete", "message": "Self-managed Auth configuration errors: BETTER_AUTH_SECRET is not set; ..." }
```

with status `503` and `private, no-store`. The affected paths are `/admin` and `/admin/*`, `/api/auth` and `/api/auth/*`, `/oauth` and `/oauth/*`, `/.well-known/oauth*`, `/mcp` and `/mcp/*`. The message lists every failing check.

## Secrets and local values

```sh
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GITHUB_CLIENT_SECRET   # self-managed only
```

Non-secret vars go in `wrangler.jsonc` under `vars`. For local development put the same names in `.dev.vars`, which the minimal reference ignores in git (`.dev.vars*`). Never commit a secret.

## First owner

Every new user receives the default role `user`, which has no staff access. The first sign-in whose GitHub login matches `ADMIN_GITHUB_LOGIN` is promoted to `owner`. Promotion is blocked once any staff user exists, so the variable only bootstraps an empty site.

## Roles

Staff roles are `owner`, `editor` and `contributor`, in descending order. Owners manage them in Admin; the underlying routes are:

| Route | Minimum role |
|---|---|
| `GET /admin/api/staff`, `PATCH /admin/api/staff/:id/role` (a role or `null` to revoke) | `owner` |
| `POST /admin/api/staff/invitations`, `DELETE /admin/api/staff/invitations/:id` | `owner` |
| `GET /admin/api/site-settings`, `PATCH /admin/api/site-settings` | `owner` |
| `GET /admin/api/members` | `editor` |
| `POST /admin/api/entries/:id/publish`, `POST /admin/api/entries/:id/unpublish`, `DELETE /admin/api/entries/:id` | `editor` |

The staff role is re-read from D1 on every protected REST and MCP call; a revoked role takes effect on the next request. Manifest-level rules such as `requires.auth` are covered in [Authorization](../concepts/authorization.md) and the [authorization reference](../reference/authorization.md).

## What needs a session

| Surface | Requirement |
|---|---|
| `/admin`, `/admin/api/*` | Staff session; role gates per route |
| `/api/auth/*`, `/oauth/*`, `/.well-known/oauth*` | Auth-owned; public endpoints of the OAuth flow |
| `/mcp` | Same caller resolution as HTTP routes (bearer, same-origin cookie session, or anonymous); each tool's `requires` gates the call, and a call that needs identity answers `401` with a `WWW-Authenticate` challenge |
| `/mcp/staff` | Authenticated caller with a staff role |
| `/<locale>/<segment>/<slug>?preview=1` | Staff session (`401` without a session, `403` without a staff role) |
| Public Views, public HTTP Triggers, public pages, `.md`, `llms.txt`, sitemap | None, unless the manifest declares `requires` |

MCP tokens are session-bound: signing out of Admin ends MCP access. See [MCP and agents](../concepts/mcp-and-agents.md).

## Session cache and database replacement

When optional session caching is enabled, the cache is derived from the
canonical store, not a second identity authority. Auth prefixes keys with
`better-auth:<store-instance-id>:`. Preparing a new store gives it a distinct
identity, so reusing the same KV namespace after replacing D1 cannot resurrect
the previous store's cached sessions. Ordinary preparation of the same store
preserves its identity.

Custom low-level Auth composition must prepare the Mantle store before cached
Auth operations; do not construct cache keys or seed the identity yourself.
OTP verification remains in the primary database and rate limiting remains
isolate-local. Revocation/user-update cache invalidation still follows KV
propagation; the namespace change is isolation across stores, not a promise of
instant global invalidation. See the [Auth decision](../../adr/0014-auth-better-auth-and-multi-tenant-mcp.md).

## Better Auth configuration

`createAuth()` owns the Worker lifecycle, Admin metadata, sender integration,
bootstrap rules, roles and MCP invariants. Method-specific configuration stays
native to Better Auth under `options`, so provider updates and type inference do
not need a matching Mantle DSL update. There is deliberately no
`Partial<BetterAuthOptions>` deep merge.

```ts
methods: [
  {
    kind: "social",
    provider: "google",
    options: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, accessType: "offline" },
  },
  {
    kind: "social",
    provider: "apple",
    options: async () => ({ clientId: env.APPLE_CLIENT_ID, clientSecret: await loadAppleSecret(env) }),
  },
  {
    kind: "email-otp",
    sender,
    options: { otpLength: 8 },
  },
]
```

Email OTP storage defaults to a keyed HMAC-SHA-256 of the code using
`BETTER_AUTH_SECRET`. Magic-link tokens remain `hashed` (high-entropy).
Explicit official overrides remain available, including `plain` and custom
hashing/encryption:

```ts
{ kind: "email-otp", sender, options: {
  storeOTP: { encrypt: encryptOtp, decrypt: decryptOtp },
} }
{ kind: "magic-link", sender, options: {
  storeToken: { type: "custom-hasher", hash: hashMagicToken },
} }
```

For complete callback ownership, register an official plugin instance directly.
Raw plugins do not add a button to `Auth.methods`; the application owns that UI.
Duplicate plugin ids fail at construction rather than silently replacing one:

```ts
createAuth({
  database: env.DB,
  baseURL: env.PUBLIC_ORIGIN,
  secret: env.BETTER_AUTH_SECRET,
  methods: [],
  plugins: [emailOTP({ sendVerificationOTP, storeOTP: "encrypted" })],
});
```

When several first-party apps share one parent domain that the same party controls, configure shared cookies explicitly. `cookiePrefix` is required whenever more than one Better Auth app writes cookies under that domain; `trustedOrigins` is the auth-flow trust list, not a CORS policy.

```ts
const auth = createAuth({
  database: env.DB,
  baseURL: "https://platform.example.com",
  secret: env.BETTER_AUTH_SECRET,
  methods,
  trustedOrigins: ["https://example.com", "https://www.example.com"],
  cookiePrefix: "example-platform",
  crossSubDomainCookies: { enabled: true, domain: "example.com" },
});
```

Shared cookies do not cross registrable domains. A browser never sends an `example.com` cookie to `customer.com`. For a customer-owned domain, use an OAuth/OIDC broker flow: the customer site redirects to the identity provider's authorize endpoint, receives the callback, verifies the response and creates its own local session. The broker returns identity; the customer site remains the authority for its members and grants.

### Account linking across providers

One person signing in with Google, then with GitHub, may land on one user row
or be refused — Better Auth decides this, and `createAuth()` does not override
it. Left unconfigured, Better Auth's own defaults apply: implicit linking is
on, so a social sign-in whose provider reports a verified email attaches to the
existing row carrying that email. It never creates a second row for the same
address; when linking is not permitted the sign-in fails with
`account not linked`.

Two defaults are worth knowing before you change anything. `requireLocalEmailVerified`
is on, so linking is refused while the *local* row is still unverified — this is
what stops someone pre-registering an unverified row at your user's address and
having that user's Google identity attach to it. It is also why a staff invitation
(`inviteUser` writes `emailVerified: 0`) cannot be claimed by a social sign-in
until the invitee verifies by email once. Separately, `trustedProviders` is
empty, so every provider must supply `email_verified` to link at all.

Pass `accountLinking` to scope this. It is forwarded verbatim:

```ts
const auth = createAuth({
  database: env.DB,
  baseURL: env.PUBLIC_ORIGIN,
  secret: env.BETTER_AUTH_SECRET,
  methods,
  accountLinking: {
    // Accept these providers' word without an `email_verified` claim.
    trustedProviders: ["google", "github"],
  },
});
```

Listing a provider in `trustedProviders` asserts that it verifies the addresses
it returns; a provider that does not turns the list into an account-takeover
path. To go the other way and keep every identity separate, set
`disableImplicitLinking: true` (users may still link deliberately via
`linkSocial()` while signed in) or `enabled: false` to refuse linking outright.

## Self-hosted and hosted

A free self-hosted site runs every method `createAuth()` exposes: Better Auth social providers, email OTP, magic link, and parent-domain SSO. The owner supplies provider credentials, email sending and cookie policy. Hosted auth is an operations convenience: the platform holds provider and email configuration and registers the site as a PKCE client, while the site still owns grants, members, content and `ctx.user`/`ctx.staff` mapping. Neither mode changes the runtime's authorization vocabulary.

## Replacing Auth construction

```ts
createMantleWorker({
  plan,
  auth: (env) => createAuth({ /* curated, site-specific methods */ }),
});
```

With `auth` set, `MANTLE_AUTH_MODE` and the mode variables are not read. Core still owns the Auth routes: the factory's `basePath` joins the reserved paths, the MCP resource defaults to `auth.mcpResource ?? <PUBLIC_ORIGIN>/mcp`, and a rejected `auth.ready` evicts the isolate's assembly. Keep the D1 `DB` binding; Better Auth tables live there.

## OAuth resource primitives

When one Mantle site is an OAuth client of another, request a stable RFC 8707
resource and use standard `offline_access` when refresh is needed:

```ts
const clientAuth = createAuth({
  // database, baseURL, secret, other methods...
  methods: [{
    kind: "oauth",
    options: {
      providerId: "mantle-platform",
      clientId: env.PLATFORM_CLIENT_ID,
      discoveryUrl: "https://platform.example.com/api/auth/.well-known/openid-configuration",
      scopes: ["openid", "offline_access", "accounts:read"],
      authorizationUrlParams: { resource: "https://api.example.com" },
      tokenUrlParams: { resource: "https://api.example.com" },
      refreshTokenParams: { resource: "https://api.example.com" },
    },
  }],
});

const { accessToken, accessTokenExpiresAt, scopes } =
  await clientAuth.getProviderAccessToken(request, "mantle-platform");
```

The server-side getter is bound to the current local session request and never
returns a refresh token or account row. On the provider:

```ts
const providerAuth = createAuth({
  // database, baseURL, secret, methods...
  oauthProvider: {
    loginPage: "/sign-in",
    consentPage: "/consent",
    scopes: ["openid", "offline_access", "accounts:read"],
    resources: ["https://api.example.com"],
  },
});

const verification = await providerAuth.verifyOAuthAccessToken(request, {
  audience: "https://api.example.com",
  scopes: ["accounts:read"],
});
```

The verifier accepts JWT access tokens only and checks the configured issuer,
JWKS/signature, audience, time claims, required scopes, and—when passed the
request—DPoP proof binding with database-backed replay protection. It returns
only `userId`, `clientId`, `credentialId`, and scopes. Opaque tokens are
rejected; there is no introspection fallback.

## Enterprise-Managed Authorization

MCP's [Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)
extension lets an enterprise IdP decide which employees may reach an MCP
server. The MCP client exchanges the user's IdP login for an ID-JAG (identity
assertion authorization grant) and presents it to the server's token endpoint
as `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`; no consent page
is shown. Everything after that is an ordinary access token.

Core does not know any issuer or JWKS. The token grant is a
`@better-auth/oauth-provider` extension supplied by the adopter through
`oauthProvider.extensions`, appended after Core's own claims extension:

```ts
import { identityAssertionAuthorizationGrant } from "@aotterclam/id-jag";

const auth = createAuth({
  // database, baseURL, secret, methods...
  oauthProvider: {
    loginPage: "/admin/sign-in",
    consentPage: "/oauth/consent",
    scopes: ["mcp", "offline_access"],
    mcpResource: env.PUBLIC_ORIGIN + "/mcp",
    extensions: [
      identityAssertionAuthorizationGrant({
        issuer: env.ENTERPRISE_IDP_ISSUER,
        jwksUrl: env.ENTERPRISE_IDP_JWKS_URL,
        authorizationServer: env.PUBLIC_ORIGIN,
        resource: env.PUBLIC_ORIGIN + "/mcp",
        scopes: ["mcp"],
        fetchJwks: (input, init) => fetch(input, { ...init, redirect: "manual" }),
      }),
    ],
  },
});
```

The extension validates the assertion's signature, issuer, audience and
lifetime, maps its subject to a user, and issues tokens through the provider's
shared token path, so `verifyOAuthAccessToken`, DPoP and the MCP challenge
behave exactly as for interactive grants. `@aotterclam/id-jag` is a reference
implementation, not a Core dependency; any `OAuthProviderExtension` works.
Extensions may also add client-authentication strategies, discovery metadata
and additional claims. The same passthrough applies without `mcpResource`.

## Source
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`packages/adapters/cloudflare/src/auth/conventionalAuth.ts`](../../../packages/adapters/cloudflare/src/auth/conventionalAuth.ts)
- [`packages/adapters/cloudflare/src/auth/createAuth.ts`](../../../packages/adapters/cloudflare/src/auth/createAuth.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/adapters/cloudflare/src/mount/mountPublicRoutes.ts`](../../../packages/adapters/cloudflare/src/mount/mountPublicRoutes.ts)
- [`packages/adapters/cloudflare/src/mount/mountMcp.ts`](../../../packages/adapters/cloudflare/src/mount/mountMcp.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`docs/auth-hosting-model.md`](../../../docs/auth-hosting-model.md)
- [`docs/adapter-guide.md`](../../../docs/adapter-guide.md)
- [`docs/examples/host-local-admin-otp/src/index.ts`](../../../docs/examples/host-local-admin-otp/src/index.ts)
- [`docs/examples/host-local-admin-otp/.dev.vars.example`](../../../docs/examples/host-local-admin-otp/.dev.vars.example)
- [`docs/examples/host-minimal-worker/.gitignore`](../../../docs/examples/host-minimal-worker/.gitignore)
