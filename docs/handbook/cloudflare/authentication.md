---
description: Configure MANTLE_AUTH_MODE, secrets, the first owner and staff roles; understand which routes need a session.
---
# Authentication

Conventional Auth is chosen by one variable, `MANTLE_AUTH_MODE`, and fails closed when its configuration is incomplete. This page covers the two modes, the secrets each needs, first-owner bootstrap, roles, the routes that require a session, and the curated Better Auth surface.

## Mode matrix

| Mode | Non-secret vars | Worker secrets | Must be absent |
|---|---|---|---|
| `self-managed` | `MANTLE_AUTH_MODE=self-managed`, `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`, `ADMIN_GITHUB_LOGIN` | `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` | `MANTLE_HOSTED_AUTH_ISSUER`, `MANTLE_HOSTED_AUTH_CLIENT_ID` |
| `hosted` | `MANTLE_AUTH_MODE=hosted`, `PUBLIC_ORIGIN`, `MANTLE_HOSTED_AUTH_ISSUER`, `MANTLE_HOSTED_AUTH_CLIENT_ID`, `ADMIN_GITHUB_LOGIN` | `BETTER_AUTH_SECRET` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

Validation rules:

- `PUBLIC_ORIGIN` is the site's HTTPS origin without a trailing slash. When unset, the adapter falls back to `http://localhost:8787`.
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
| `/mcp` | Any authenticated OAuth caller; anonymous requests get `401` with a `WWW-Authenticate` challenge |
| `/mcp/staff` | Authenticated caller with a staff role |
| `/<locale>/<segment>/<slug>?preview=1` | Staff session (`401` without a session, `403` without a staff role) |
| Public Views, public HTTP Triggers, public pages, `.md`, `llms.txt`, sitemap | None, unless the manifest declares `requires` |

MCP tokens are session-bound: signing out of Admin ends MCP access. See [MCP and agents](../concepts/mcp-and-agents.md).

## Curated Better Auth surface

`createAuth()` exposes curated fields, not a Better Auth passthrough: `database`, `baseURL`, `secret`, `methods`, `bootstrapOwner`, `oauthProvider`, `rateLimit`, and for first-party SSO `trustedOrigins`, `cookiePrefix` and `crossSubDomainCookies`. There is no `betterAuthOptions` or `advanced` escape hatch; a new Better Auth knob appears only when a Mantle use case justifies a first-class field.

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
- [`docs/examples/minimal-worker/.gitignore`](../../../docs/examples/minimal-worker/.gitignore)
