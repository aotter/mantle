# ADR-0014: Better Auth as the auth + MCP authorization server, scope-derived multi-tenant MCP

## Status

Accepted (new). Amended 2026-05-14 — formalize "Better Auth as default implementation, `Auth` interface as the SDK contract" (see § "Auth as contract, Better Auth as default").

## Date

2026-05-09 (amended 2026-05-14)

## Context

The pre-v0.1.0 auth surface is a hand-rolled GitHub-only flow stitched out of two libraries:

- `@cloudflare/workers-oauth-provider` (DCR-compliant authorization server for MCP — `/oauth/{authorize,token,register}`, `.well-known/oauth-authorization-server`, KV-backed token storage)
- A hand-rolled GitHub upstream OAuth client (`oauth/githubOAuth.ts` ~110 LOC)
- D1 tables: `users`, `social_logins`, `sessions`, `github_tokens`, `staff` overlay
- `ensureBootstrapOwner` env-var gated (`ADMIN_GITHUB_LOGIN`)
- `cms_session` cookie carries the staff session
- Single `/mcp` route gated to staff bearers only

Pre-launch we promised the `publication` family then `community` and `fan-club` (#58 taxonomy). Both require:

1. **Multi-IDP end-user login** — GitHub, Google, Apple, plus magic link / email OTP for users without OAuth accounts
2. **End-user MCP access via DCR** — let signed-in end-users grant a Claude / Cursor / Codex agent read access to their own subscriptions, comments, member-only posts

Trying to grow the existing hand-rolled stack into that shape — three IDPs, two paths to magic link, account linking with reauth, scope-based MCP gating, role machinery for both staff and end-user, end-user DCR through `workers-oauth-provider` — accumulates fast (~1500 LOC of auth code by v0.2). Cloudflare itself does not ship a transactional-email-for-app-auth product (Cloudflare Access's "One-time PIN" gates Zero Trust resources, not public-site users), so the email-OTP path needs an external sender regardless.

The "single `/mcp` with config flags" pattern explodes combinatorially when scope, role, surface, and feature flags interact. Each new feature multiplies the matrix.

A 2026 Workers-friendly auth library — [Better Auth](https://better-auth.com) — covers this entire space:

- Identity / sessions / accounts (the obvious thing every auth library does)
- Multi-IDP via `socialProviders` (GitHub / Google / Apple / 30+ more)
- Magic link (`magicLink` plugin) and email OTP (`emailOTP` plugin) with pluggable email sender
- Role machinery (`admin` plugin, `user.role` field on user table)
- **OAuth 2.1 provider with DCR (`oauthProvider` plugin)** — full RFC 7591 dynamic client registration, RFC 7662 introspection, RFC 7009 revocation, scope-based access control, custom token claims, consent UI redirect customization
- **MCP plugin (`mcp`)** — purpose-built on top of the OAuth 2.1 provider for MCP DCR; auto-mounts `.well-known/oauth-authorization-server` + `.well-known/oauth-protected-resource`, exposes `auth.api.getMcpSession()` for protected-resource validation
- Account linking with policies (verified-email match + reauth requirement)

Better Auth depends on a Kysely / Drizzle / Prisma adapter for the database, not on any Cloudflare-specific service. The auth machinery becomes platform-agnostic — porting to Netlify / Bun / Deno is config-only.

## Decision

### 1. Better Auth replaces both layers

Adopt Better Auth as the SDK's full auth surface. It owns:

- `user` / `session` / `account` / `verification` D1 tables (replaces our `users` / `social_logins` / `sessions` / `github_tokens`)
- Cookie session (replaces `cms_session` with `better-auth.session_token`)
- Upstream OAuth clients for GitHub, Google, Apple via `socialProviders` (replaces `oauth/githubOAuth.ts`)
- Magic link plugin (replaces the `email_verifications` table we would otherwise hand-roll)
- Email OTP plugin
- `admin` plugin for role machinery (replaces the `staff` table — `user.role` carries the role string)
- **`oauthProvider` (or `mcp`) plugin for DCR-compliant authorization server** (replaces `@cloudflare/workers-oauth-provider`)

`@cloudflare/workers-oauth-provider` is removed entirely. The `OAUTH_KV` binding is no longer required. The whole `packages/adapters/cloudflare/src/oauth/` directory disappears (singleton wiring, hand-rolled GitHub OAuth, consent HTML renderer with locale list — Better Auth's consent flow replaces).

The auth runtime stops being an adapter port. `OAuthVerifier` port + `WorkersOAuthVerifier` adapter are deleted. Validating bearer tokens at `/mcp` and `/staff/mcp` becomes `auth.api.getMcpSession(req.raw)` — a direct Better Auth API call, no port indirection.

This makes the runtime more platform-agnostic, not less: Better Auth runs on Workers (D1 via Kysely), Bun (sqlite), Node (postgres) without code changes. Future Netlify / partner adapters get the auth surface for free.

### 2. `staff` table → `user.role` via Better Auth admin plugin

The `admin` plugin stores a `role` field on the `user` table. Configure:

```ts
admin({
  defaultRole: "user",                                 // every end-user
  adminRoles: ["owner", "editor", "contributor"],      // our existing staff vocabulary
})
```

`ensureBootstrapOwner` becomes a `databaseHooks.user.create.after` that promotes the first user matching `ADMIN_GITHUB_LOGIN` to `owner` if no other admin role exists yet. The `staff` D1 table, `D1StaffRepository`, `StaffRepository` port, and `runtime.staff` are deleted.

The manifest grammar predicate `requires.auth.all: [{ "ctx.staff": ["editor"] }]` evaluates against `session.user.role` at runtime. Closed enum membership unchanged.

What we lose: `grantedBy` / `grantedAt` audit trail. v0.1.0 doesn't need this; v0.1.x can re-add via `additionalFields` on user, or via a separate append-only `staff_audit_log` table.

### 3. Two MCP routes, surface-derived from manifest predicate

`/mcp` and `/staff/mcp` are mounted side-by-side from boot. v0.1.0 ships the conservative partition: `/staff/mcp` exposes all staff authoring/lifecycle tools and requires `mcp:staff` plus an admin role; `/mcp` exposes only read-only `query_view_<name>` tools and requires `mcp:read`. The v0.2+ extension point is **automatic** surface partition derived from each Procedure's `requires.auth.all` predicate:

```
predicate contains ctx.staff: [...]    → tool exposed on /staff/mcp only
predicate only ctx.user / no predicate → tool exposed on /mcp only
```

Tool partition rules:

- Per-collection auto-emitted authoring tools (`create_draft_<schema>`, `update_draft_<schema>`) — predicate baked-in to require `ctx.staff: [contributor+]`; route to `/staff/mcp`
- `list_entries` / `get_entry` / `request_publish` / `archive_entry` / `unpublish_entry` — staff-only (return drafts, mutate state); `/staff/mcp` only
- `query_view_<name>` (auto-emitted from each parsed View, mirroring the existing `/api/views/<name>` REST shape) — public; `/mcp` only
- v0.2 community / v0.2.x fan-club user-facing writes (comment, reaction, subscribe, ...) — predicate `ctx.user` or `ctx.user.subscription`; `/mcp`

### 4. Scope-aware DCR via Better Auth `oauthProvider`

Better Auth's `oauthProvider` plugin handles DCR. Configure:

```ts
oauthProvider({
  scopes: ["mcp:staff", "mcp:read"],
  clientRegistrationDefaultScopes: ["mcp:read"],
  clientRegistrationAllowedScopes: ["mcp:staff", "mcp:read"],
  validAudiences: [
    "https://<worker>/staff/mcp",
    "https://<worker>/mcp",
  ],
  consentPage: "/auth/consent",
  customAccessTokenClaims: ({ user, scopes }) => ({
    role: user.role,
  }),
})
```

Consent UI semantics:

- `mcp:staff` requested — only admin-role users can approve. Non-admin sessions see "you need to be staff to grant this scope."
- `mcp:read` requested — any signed-in user can approve.
- Mixed `["mcp:staff", "mcp:read"]` — admin-role users grant both; non-admin users grant only `mcp:read` with a notice.

The consent page (`/auth/consent`) is consumer-rendered; SDK ships a minimal HTML fallback for starters that don't customize.

Each MCP route validates token scope at request time via `auth.api.getMcpSession()`:

- `/staff/mcp` requires `mcp:staff` ∈ session.scopes
- `/mcp` requires `mcp:read` ∈ session.scopes (`mcp:staff` accepted as superset)

The Better Auth MCP plugin exposes the RFC 9728 protected-resource metadata document at the auth mount (`/api/auth/.well-known/oauth-protected-resource` in the Cloudflare starter). Both `/staff/mcp` and `/mcp` point unauthenticated clients at that metadata document through `WWW-Authenticate`.

### 5. Role checked dynamically, not embedded in token

The token can carry `role` via `customAccessTokenClaims` for caller convenience, but the **MCP route validators always re-read `user.role` fresh** via the session. Cost: ~1ms D1 lookup per request (Better Auth's session cache absorbs most of this). Win: a demoted user is locked out immediately, not at token expiry. Same pattern for the consent UI staff gate.

### 6. Single auth surface, no port indirection

Auth is no longer an adapter port. `mantle-runtime` does NOT define an auth port and `createCmsRuntime()` does not accept auth. Adapter packages (`mantle-cloudflare`, future `mantle-netlify`) construct the Better Auth instance with the right database adapter for their platform and keep it in the adapter-owned HTTP/MCP mount layer.

The adapter uses Better Auth to validate sessions, MCP bearer tokens, scopes, and roles, then passes authenticated user/staff context into runtime dispatchers. Better Auth remains platform-agnostic, but it is not a runtime dependency.

This is a minor amendment to ADR-0011 (adapter port spec): the auth ports disappear and auth becomes adapter-owned mount wiring. The hard invariant ("`mantle-runtime` MUST NOT import `D1Database` / `KVNamespace`") is preserved.

### 7. Auth as contract, Better Auth as default

**Amended 2026-05-14.** The seven auth-cascade PRs (#160 / #161 / #162 / #165 / #167 / #169 / #173) shipped Better Auth-backed config + admin SPA + tests. During that work two architectural lines need to be explicit so future PRs don't drift toward mechanical pass-through:

**The SDK's public auth contract is the `Auth` interface, not Better Auth.**

`packages/adapters/cloudflare/src/auth/createAuth.ts` exports:

```ts
export interface Auth {
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (request: Request) => Promise<{...} | null>;
  readonly getMcpSession: (request: Request) => Promise<{...} | null>;
  readonly getUserRole: (userId: string) => Promise<string | null>;
  readonly methods: ReadonlyArray<AuthMethodInfo>;
}
```

The internal consumers of `Auth` (post-#193: `mountServerEndpoints`, `createMcpApiHandler`, `mountAuthorize`, `bootRuntimeOnce`, `cmsConfig`) all import only the `Auth` type — never `betterAuth`, never any plugin internals. Better Auth is imported in exactly one file (`createAuth.ts`).

**`createAuth(config)` is the SDK-shipped, Better Auth-backed *default* implementation.** Adopters who want the curated `methods[]` shape, `bootstrapOwner` promotion, Workers-aware rate-limit, fire-and-forget `backgroundTasks.handler`, `extras` reserved-key validation, and the `Auth.methods` admin-SPA contract — pass a config to `createAuth()` and get an `Auth`.

**Adopters who want a different backend implement `Auth` directly and bypass `createAuth`.** Lucia, Auth.js, a custom hand-roll — all valid. The seam already works today; the `/api/auth/*` URL convention (which Better Auth picks for its mounted endpoints) is a second-tier contract that affects the admin SPA. `auth-views.tsx` hard-codes six paths today (`/api/auth/methods`, `/api/auth/sign-in/social`, `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp`, `/api/auth/sign-in/magic-link`, `/api/auth/sign-out`); replacing the backend means matching the URL convention OR forking `auth-views.tsx`.

**Anti-pattern to refuse in review: Better Auth-field pass-through.**

If a future PR's only effect is to rename a Better Auth field into our `CreateAuthConfig` and forward it verbatim, refuse it. **Picking a different literal default for an existing Better Auth field does NOT, by itself, justify a new field on `CreateAuthConfig` — that's the same pass-through dressed up.** The SDK adds load-bearing surface area only when the new field exists for at least one of these concrete reasons:

- **Workers-aware behavior** that Better Auth doesn't supply (e.g. `rateLimit` flipped on by default when an email-shaped method registers — Better Auth's per-route limits gate on `process.env.NODE_ENV === "production"` which is unset on Workers; `advanced.backgroundTasks.handler` wired to fire-and-forget — closes the timing-oracle on OTP send).
- **Cross-adapter port** the runtime needs (e.g. `EmailSender` in `mantle-runtime/domain/port/` — used by both `createAuth`'s OTP / magic-link callbacks AND future use cases like order receipts).
- **Safety net** Better Auth doesn't provide (e.g. `extras` reserved-key validation refuses to let an adopter shadow `clientSecret` via spread order; bootstrap-method cross-check refuses `match: "github-login"` with no `github` social registered).
- **New abstraction** that fuses multiple Better Auth surfaces (e.g. `methods[]` unifies `socialProviders` + `emailOTP` + `magicLink` plugins under one config shape with shared per-method discrimination).
- **DX helper that removes a Workers-hostile dep** (e.g. `appleClientSecret` signs the ES256 JWT via `crypto.subtle` so adopters don't have to install `jose` for the one task Better Auth's docs assume a JWT lib).

A different default value on its own is not on this list. Default tweaks live in adopter code.

> **Retracted by Amendment 2026-05-15.** This section originally pointed at a `CreateAuthConfig.betterAuthOptions?: Partial<BetterAuthOptions>` escape hatch (introduced in PR #175). The 2026-05-15 OAuth carve-out (PR #193) removed it. With the MCP OAuth surface now served by `@cloudflare/workers-oauth-provider`, the un-curated knob set Better Auth still owns (staff sign-in, social, OTP, magic-link, role) is small enough that the curated `methods[]` / `rateLimit` / `bootstrapOwner` fields cover the adopter contract. When a missing Better Auth knob is real and load-bearing, the answer is a curated first-class field — not a passthrough. See § "Amendment 2026-05-15" below.

This makes the implicit explicit. The SDK's auth surface is committee-curated; un-curated knobs require either a justified first-class field or an architectural change to remove the dependency on that knob.

### 8. Path to `@aotter/mantle-better-auth` separate package (deferred)

When `mantle-netlify` lands, the Better Auth wiring moves to its own package. Today the seam is in place:

- `Auth` interface lives in the adapter (could move to runtime or a separate package without breaking the contract — adapters consume the type, not the implementation).
- `createAuth.ts` is the only file with `import { betterAuth }` (~290 LOC, no Cloudflare-binding-specific code outside `config.database: D1Database`).
- `ConsoleEmailSender.ts` is dev-only and platform-agnostic (~25 LOC).
- `appleClientSecret.ts` uses Web Crypto (`crypto.subtle`) which Workers + Node 18+ + Bun + Deno all share (~150 LOC).

The future split looks like:

```
@aotter/mantle-runtime           ← ports + use cases (today)
@aotter/mantle-better-auth       ← createAuth + EmailSender impls + appleClientSecret (new, when needed)
@aotter/mantle-cloudflare        ← Workers adapter; depends on (or accepts) Auth-shape (today)
@aotter/mantle-netlify           ← Netlify adapter; same shape (v0.2)
```

The pivot point — when to extract — is when the second adapter (`mantle-netlify`) needs the same wiring. Until then, in-place co-location is cheaper than a new package boundary.

## Consequences

### What gets deleted

- `packages/adapters/cloudflare/src/oauth/` entire directory (`githubOAuth.ts`, `consentHtml.ts`, `oauthSingleton.ts`, `oauthConstants.ts`, `index.ts`)
- `packages/adapters/cloudflare/src/bindings/D1UserRepository.ts`
- `packages/adapters/cloudflare/src/bindings/D1SessionRepository.ts`
- `packages/adapters/cloudflare/src/bindings/D1StaffRepository.ts`
- `packages/adapters/cloudflare/src/bindings/WorkersOAuthVerifier.ts`
- `packages/adapters/cloudflare/src/bindings/StubOAuthVerifier.ts`
- `mantle-runtime/src/domain/port/UserRepository.ts`
- `mantle-runtime/src/domain/port/SessionRepository.ts`
- `mantle-runtime/src/domain/port/StaffRepository.ts`
- `mantle-runtime/src/domain/port/OAuthVerifier.ts`
- `mantle-runtime/src/runtime.ts` `users` / `sessions` / `staff` / `oauth` ports
- `mountServerEndpoints.ts` `/admin/auth/github` + callback (Better Auth handles), session cookie read/write code, `ensureBootstrapOwner` inline logic (moves to hook), OAuth consent UI handlers (`/oauth/authorize` GET/POST), OAuth provider passthrough (`/oauth/token`, `/oauth/register`, `.well-known/*`)
- D1 tables: `users`, `social_logins`, `sessions`, `github_tokens`, `staff`
- `OAUTH_KV` binding (no longer required in `wrangler.toml`)
- `@cloudflare/workers-oauth-provider` dependency

### What stays

- `mount/mountMcp.ts` — refactored to mount both `/mcp` + `/staff/mcp`, validates via `auth.api.getMcpSession()`, and enforces route scopes.
- `infrastructure/mcp/McpJsonRpcDispatcher.ts` — refactored to support staff vs public tool catalogs.
- All entries / publish / view machinery (zero auth-related changes)
- Admin SPA — sign-in view rewritten to redirect to Better Auth route; identity / role queries use Better Auth client

### What gets added

- Better Auth library + Kysely + `kysely-d1` packages (or whichever D1 adapter Better Auth recommends current)
- Better Auth instance at `packages/adapters/cloudflare/src/auth/createAuth.ts` (factory taking env / D1 binding)
- New `EmailSender` port + `ResendEmailSender` adapter impl (used by Better Auth `magicLink` / `emailOTP` plugins)
- `databaseHooks.user.create.after` for `ensureBootstrapOwner` semantics
- Two `/.well-known/oauth-protected-resource/*` metadata endpoints (Better Auth helpers)
- Public View MCP tools: dispatcher emits `query_view_<name>` on `/mcp`.
- Future manifest grammar tools: dispatcher will read `Procedure.requires.auth.all` to route user-facing tools to `/mcp` or `/staff/mcp`.
- Skills + docs updates for the dual MCP URL handoff

### Backward compatibility

None. Pre-v0.1.0 has no external consumers. Existing demo deployments tear down + re-bootstrap from the migrated `0.0.x-alpha` release.

### Skills + launch handoff

The Mantle landing launch session and generated repo-local
`mantle:provision` skill document the dual MCP handoff. Provision's final
report distinguishes:

```
Public site:    https://<worker>.workers.dev/
Staff MCP URL:  https://<worker>.workers.dev/mcp/staff     (give to your owner agent)
User MCP URL:   https://<worker>.workers.dev/mcp           (give to visitors / their agents)
```

The publication starter repo's production smoke recipe uses `/mcp/staff`
for the MCP operator smoke step.

### Future-proof for v0.2

The end-user MCP via DCR + role-gated content (community / fan-club) requires no architectural change — just:

- Enable Better Auth `socialProviders.google` / `.apple` (config-only)
- Enable `magicLink` and `emailOTP` plugins (config + `EmailSender` wiring already in place)
- Promote DRAFT manifest grammar from POC ADR-0005 — `Schema.spec.policies.readable: ctx.user` and `requires.auth.all: [{ ctx.user.subscription: [premium] }]`
- Add `additionalFields: { subscriptionTier: ... }` on user when Stripe entitlement lands

No config flag flips, no surface migration. The dispatcher partition rule (predicate → surface) handles new tool emission automatically.

### Platform agnosticism

By removing `@cloudflare/workers-oauth-provider` and routing auth through Better Auth, the SDK no longer depends on any CF-specific auth service. A future Netlify adapter constructs a Better Auth instance backed by a Netlify-compatible D1 / postgres / sqlite database; the rest of the runtime + dispatcher + skills + prompts work unchanged. ADR-0011 (adapter port spec) is amended: the `OAuthVerifier` port disappears; auth becomes a direct constructor argument with platform-agnostic Better Auth as the type.

## Alternatives considered

### Alt-A: Hand-rolled multi-IDP without a library

Continue the existing `oauth/githubOAuth.ts` pattern, write `googleOAuth.ts` and `appleOAuth.ts`, wire account-linking by hand, keep `workers-oauth-provider` for DCR.

**Rejected** — Apple Sign In's JWT-signed client secret rotation (every 6 months) is non-trivial; account-linking with reauth flow has security pitfalls; magic-link / email-OTP adds 200+ LOC of token storage + send + verify per flow. Total scope is ~1500 LOC of auth code for v0.2. Better Auth covers this with config + plugins.

### Alt-B: arctic library for upstream IDPs, keep `workers-oauth-provider` for DCR

Use [arctic](https://arcticjs.dev) for upstream IDP clients, keep our existing `users` / `social_logins` / `sessions` / `staff` schema, hand-roll session management + account linking + magic link, retain `workers-oauth-provider`.

**Rejected** — arctic only solves the OAuth client step (~150 LOC saved). Session management, role machinery, account linking with reauth, magic-link plugin — all still hand-rolled. `workers-oauth-provider` retained means we still glue two systems. Compared to Better Auth (which absorbs all of these into one), arctic forces more glue code AND keeps the platform coupling.

### Alt-C: Better Auth for upstream IDPs, keep `workers-oauth-provider` for DCR

Adopt Better Auth as identity / session / role authority. Keep `workers-oauth-provider` because it's a known-good DCR implementation.

**Rejected as of 2026-05-09** — initial draft of this ADR took this position. Web research showed Better Auth's `oauthProvider` and `mcp` plugins cover the DCR concern with full RFC 7591 / 7662 / 7009 / 9728 compliance. Keeping `workers-oauth-provider` would mean two systems sharing user identity but with different cookie / token / session caches — operationally messier than a single auth surface. The platform-agnosticism win (no CF-specific auth lib) tips the balance.

### Alt-D: Single `/mcp` with role + scope flags

Keep one MCP route. Gate with config flags: `mcpRequiresStaff`, `mcpAllowEndUser`, scope checks per tool.

**Rejected** — flag combinatorics explode as we add subscription tiers + per-collection visibility. Two routes derived from manifest predicate eliminates the flag matrix entirely; the rule is reviewable as a single sentence.

### Alt-E: Two separate Better Auth `oauthProvider` instances

One DCR provider for staff MCP, one for end-user MCP.

**Rejected** — two consent UIs, two token tables, double the configuration burden, no real benefit. Single auth server with scope-based gating achieves the same separation cleanly per the OAuth spec.

### Alt-F: `staff` table preserved alongside Better Auth user table

Keep our `staff` overlay and `D1StaffRepository`. Use Better Auth only for identity / session / account, route role machinery through staff overlay.

**Rejected** — duplicate role data (Better Auth `admin` plugin + our staff overlay) is worse than picking one. Audit trail is the only thing the standalone overlay buys, and v0.1.0 doesn't need it.

## Implementation status

Phase 0 (spike, 0.5–1d) — pending:

- Confirm Better Auth + `admin` plugin + `oauthProvider` (or `mcp`) plugin operational on D1 in Workers
- Confirm Better Auth's auto-mounted `.well-known/oauth-authorization-server` is reachable
- Confirm two `.well-known/oauth-protected-resource/*` metadata documents serve correctly (helper or hand-roll)
- Confirm DCR clients (Claude Code, Cursor) follow RFC 9728 path-prefix metadata
- Confirm `auth.api.getMcpSession()` validates bearer tokens at the protected-resource path
- Confirm `auth.api.getSession()` works inside consumer routes
- Bundle size delta on the worker

Phase 1 (migration, ~2d) — pending Phase 0:

- Better Auth integration (publication starter + mantle-cloudflare adapter)
- Schema cut-over (canonical migrations rewrite, drop legacy auth tables, add Better Auth tables)
- Drop `oauth/` directory, all auth ports, `WorkersOAuthVerifier`, `StubOAuthVerifier`
- Drop `@cloudflare/workers-oauth-provider` dep + `OAUTH_KV` binding
- Mount factories rewrite (`mountServerEndpoints` for admin gate, `mountMcp` for dual-route)
- Dispatcher refactor (per-tool surface routing from manifest predicate)
- Tests update (`mcp-smoke` → `staff-mcp-smoke` + new `public-mcp-smoke`)
- Skills + prompts + starter README updates
- Admin SPA sign-in view rewrite

Phase 2 (v0.1.x):

- Enable Google + Apple `socialProviders` (config-only — Apple needs Apple Developer cert setup which is consumer-side)
- Magic-link + email-OTP plugins enabled (need `ResendEmailSender` wired)
- Account-linking with reauth UI in publication starter

Phase 3 (v0.2+, with community / fan-club):

- POC ADR-0005 DRAFT grammar promotion: `Schema.spec.policies.readable`, `requires.auth.all: ctx.user.subscription[*]`
- Subscription tier on user (`additionalFields`)
- Stripe webhook → entitlement updater
- Community / fan-club starter manifests

## How to apply

When reviewing or implementing a change that touches auth, MCP routing, or roles:

1. **Identity / session / account state** — Better Auth API. Don't hand-write D1 reads against `user` / `session` / `account`. Use `auth.api.*`.
2. **Role check** — read `session.user.role` (from `auth.api.getSession()` or `auth.api.getMcpSession()`). Don't query a `staff` table; it doesn't exist.
3. **MCP tool routing** — let the dispatcher derive surface from `Procedure.requires.auth.all`. Don't add a per-tool `surface: 'staff' | 'public'` field; the predicate is the source of truth.
4. **DCR consent gating** — scope-based via Better Auth `oauthProvider` config. `mcp:staff` requires admin role; `mcp:read` accepts any signed-in user. Don't add a separate consent path or config flag.
5. **Token props** — minimal. If you need role in the token payload for caller convenience, add via `customAccessTokenClaims`, but always re-validate fresh on the server side.
6. **Email** — call `EmailSender` port. CF adapter binds Resend; consumer can swap.
7. **Adapter portability** — the auth surface is platform-agnostic. A new adapter (Netlify / Bun / Deno) constructs Better Auth with its preferred DB adapter and passes the instance to the runtime. No port re-implementation needed.

## Sources

- [Better Auth MCP plugin docs](https://better-auth.com/docs/plugins/mcp)
- [Better Auth OAuth 2.1 Provider plugin docs](https://better-auth.com/docs/plugins/oauth-provider)
- [Better Auth admin plugin docs](https://better-auth.com/docs/plugins/admin)
- [Better Auth changelog (1.5+)](https://better-auth.com/blog/1-5)
- [RFC 7591 — Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 9728 — Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)

## Amendment — 2026-05-15: MCP carve-out to `@cloudflare/workers-oauth-provider`

Empirical follow-up to the §"Decision" record above. After shipping the Better Auth `mcp()`-plugin path through `0.0.8-beta.5`, Claude Desktop and claude.ai (web) consistently failed at the OAuth handover even though the server-side dance was RFC-correct (DCR + PKCE + AS metadata + PRM all verified via `wrangler tail`). The Anthropic-side error always surfaced as a generic `ofid_*` reference; `/token` returned 200, then the MCP client never made the post-OAuth `/staff/mcp` POST.

We built an isolated POC worker (`the deleted MCP POC worker`, since deleted) that ran `@cloudflare/workers-oauth-provider` at top level with a single dummy `echo` MCP tool. The POC connected to claude.ai cleanly. Migrating the same pattern back to `the legacy MCP test deployment`, three constraints were narrowed:

1. **MCP resource path must start with `/mcp`.** `/staff/mcp` fails (claude.ai drops the session after a server-correct `/token` success). `/mcp/staff` works. Probably an Anthropic-side URL pattern check from an early MCP draft; not currently documented in any spec we found.
2. **`scopes_supported` must not contain colons.** Advertising `["mcp:read", "mcp:staff"]` causes claude.ai to silently omit `scope=` from `/authorize`, yielding a zero-scope token grant that the client then rejects post-token. Single `["mcp"]` works. Per-surface differentiation moves server-side: staff role is checked in the apiHandler via D1 `getUserRole`, not via OAuth scope.
3. **OAuth provider must be top-level worker entry.** `export default new OAuthProvider({...})` is required so the lib intercepts `/.well-known/oauth-*` + `/oauth/{authorize,token,register}` + `apiRoute(s)` before forwarding to `defaultHandler` (Hono). Side-mounting from inside Hono left the lib unable to inject `env.OAUTH_PROVIDER` for the consent handler.

### Architectural change

| Concern | Before (ADR-0014 §Decision) | After (this amendment) |
|---|---|---|
| Staff sign-in | Better Auth `admin` + social providers | Same — unchanged |
| Session / user / role | Better Auth D1 tables | Same |
| MCP OAuth AS surface | Better Auth `mcp()` plugin (opaque tokens, no JWKS) | `@cloudflare/workers-oauth-provider` (KV grants, lib-internal token format) |
| MCP endpoints | `/staff/mcp` + `/mcp` mounted in Hono with `auth.api.getMcpSession()` | `/mcp/staff` + `/mcp` registered as `apiHandlers` on the top-level OAuthProvider; lib verifies bearer + sets `ctx.props` |
| Scope | `mcp:staff` + `mcp:read` colon-namespaced | Single `["mcp"]` advertised; staff gating via D1 role lookup |
| `auth.getMcpSession()` | Part of the SDK `Auth` interface | Removed; the OAuth lib owns token verification |
| Consent UI | Better Auth's built-in | Adapter-mounted on Hono via `mountAuthorize`; reads `c.env.OAUTH_PROVIDER` helpers the lib injects, gates on `auth.getSession()` |
| URL conventions | `/api/auth/mcp/*` | `/oauth/*` — namespaced (not bare) to avoid squatting on generic root paths |

### Why Better Auth still wins the auth-side concerns

The split is clean because the two libs answer different questions:

- **Better Auth** answers "who logged into our backstage console?" — sign-in flows, social providers, session cookie, user/role state in D1.
- **workers-oauth-provider** answers "how do we authorize a third-party OAuth client (MCP) to act on a backstage user's behalf?" — DCR, PKCE, consent, token issue, KV grant store.

Removing Better Auth would force re-implementing all of (a) and gains nothing — Better Auth is uncontested for the staff sign-in surface. Removing workers-oauth-provider would force re-implementing all of (b) and was tried via Better Auth's `mcp()` plugin; the result didn't reach Anthropic-client compatibility within reasonable iterations.

### Auth-as-contract is preserved without the escape hatch

The companion `CreateAuthConfig.betterAuthOptions?: Partial<BetterAuthOptions>` escape hatch from PR #175 is **removed**. Empirically it was a contested anti-pattern: the carved-out MCP surface no longer requires per-adopter Better Auth overrides (the OAuth surface is fully delegated), and the remaining adopter-facing knobs are all curated first-class fields on `CreateAuthConfig` (`methods[]`, `rateLimit`, `bootstrapOwner`). If a Better Auth knob is missing from the SDK contract, the answer is a curated first-class field, not the un-curated escape hatch.

The original ADR-0014 §"Auth as contract, Better Auth as default" framing stays correct; only the §"Implementation status" reference to `betterAuthOptions` is retracted.

### What didn't change

- The auth port is still removed (the runtime takes the Better Auth instance directly).
- Apple's `trustedOrigins` auto-append (`https://appleid.apple.com`) and `sameSite=none` cookie injection for cross-site `form_post` callback stay.
- `appleClientSecret()` helper (from PR #173) stays.
- All non-OAuth admin endpoints (`/api/auth/*`, `/api/auth/methods`, admin SPA mount) stay on Better Auth.
- The `bootstrapOwner` + email-OTP + magic-link + `methods[]` carve-out stay.

### Future work

- A `@cloudflare/vitest-pool-workers`-based integration test covering the full OAuth flow (DCR → consent → token → MCP RPC). Node-vitest can't load `@cloudflare/workers-oauth-provider` because it imports from `cloudflare:workers`.
- Starters (`aotter/mantle-starters`) migration to the same top-level OAuthProvider shape. All 8 archetypes currently use the pre-carve-out `mountMcp` API and need updating before the next starter tag.
- Track whether Anthropic relaxes (1) the `/mcp` resource-path-prefix requirement and (2) the no-colon-in-scope requirement. Both are de-facto MCP client behaviors, not RFC requirements; if upstream relaxes them, the SDK can re-introduce `mcp:read` / `mcp:staff` scopes for finer-grained delegation.

## Amendment — 2026-06-30: Hosted-auth boundary and first-party cookie fields

Mantle Platform introduces a first-party hosted-auth use case:
`platform.mantle.tools` owns site-owner account, billing, hosted
identity, and platform email, while generated sites still own local
grants, member records, content, commerce, forms, and legal copy. The
product boundary is documented in
[`docs/auth-hosting-model.md`](../auth-hosting-model.md).

This does not change ADR-0014's core rule: Mantle does not expose an
un-curated `betterAuthOptions` or `advanced` passthrough. Missing Better
Auth knobs become first-class SDK fields only when a real Mantle use
case needs them.

The first-party SSO use case needs exactly three Better Auth fields:

- `trustedOrigins` — app-owned origins that Better Auth should trust for
  auth flows. SDK-managed provider origins, such as Apple, are still
  injected automatically.
- `crossSubDomainCookies` — Better Auth's same-parent-domain cookie
  support for a trusted first-party app family.
- `cookiePrefix` — required when two Better Auth apps can write cookies
  under the same parent domain, so Platform cookies do not collide with
  Landing or generated-site cookies.

These fields are additive. Existing consumers that do not pass them keep
the previous cookie/session behavior.

The boundary is deliberately narrower than "hosted auth everywhere":

- Free users can still self-host every login method Mantle exposes
  through `createAuth()`.
- Same-parent-domain SSO can use `crossSubDomainCookies` when the same
  party controls all participating subdomains.
- Customer-owned domains cannot receive `mantle.tools` cookies. Paid
  hosted auth for `customer.com` must use an OAuth/OIDC broker flow:
  Platform authenticates and returns identity; the customer site creates
  its own local session and maps identity into local grants.

## Amendment — 2026-07-15: one adapter-owned authorization pipeline

Epic #467 extends the auth contract without moving auth into
`mantle-runtime`. The original adapter-ownership rule remains authoritative:
Better Auth is the curated Cloudflare default for identity/session/OIDC, and
`@cloudflare/workers-oauth-provider` remains the compatibility transport for
remote MCP. Both adapters now normalize verified callers into the same
runtime context before invoking a target.

`HandlerContext` gains an additive optional `auth` member carrying only:

```ts
{
  credential: "session" | "oauth" | "api-key" | "personal-token";
  credentialId: string | null;
  clientId: string | null;
  scopes: readonly string[];
}
```

Raw keys/tokens and refresh tokens are forbidden in this context. `ctx.user`
remains the authenticated subject when one exists; `ctx.staff` is a mutable
privilege overlay and is re-read from D1 for each protected REST/MCP call.

The Cloudflare adapter exposes one `ConsumerCredentialResolver` seam for a
site to recognize and verify its own API-key or personal-token formats. It
distinguishes `not-handled`, `invalid`, and `verified`; a recognized invalid
credential never falls back to a cookie. Core adds no credential repository,
table, issuance API, or runtime auth port.

The curated Better Auth facade also adds the OAuth resource primitives needed
by a generated site acting as a client or provider:

- generic OAuth client `resource` is retained across authorization, code
  exchange, and refresh;
- OAuth provider `validAudiences` constrains minted JWT audiences;
- `getProviderAccessToken(request, providerId)` uses the current local session
  and returns no refresh token/account row;
- `verifyOAuthAccessToken()` verifies issuer/JWKS, audience, time claims, and
  scopes, rejects opaque tokens, and preserves the `401`/`403` distinction.

REST and MCP transport verification remain adapter-specific. After
normalization, both call the same runtime auth evaluator and optional guard
Procedure. Standard remote MCP continues to use its OAuth bearer and the
single compatibility `mcp` resource scope; manifest scopes are re-evaluated on
every `tools/call`. MCP does not promise to accept a raw REST API key/PAT.

Dynamic membership, billing, and entitlement state remains consumer-owned.
`requires.guard.procedure` orchestrates a site handler on every invocation but
does not introduce a Policy atom or an entitlement service. See
[`API and MCP authorization`](../api-mcp-authorization.md) for the public API
and end-to-end examples.
