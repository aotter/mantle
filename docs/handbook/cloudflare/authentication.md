# Auth in Mantle

Your application configures `betterAuth()` and its official plugins in `auth.ts`.
Mantle supplies the database adapter, schema generation and caller resolution:

| Mantle | What it does |
| --- | --- |
| `@aotter/mantle/auth/adapter` | `d1Adapter(env.DB)` / `postgresAdapter(sql)`: Better Auth's `database` on the same native handle as your data, no Kysely. `postgresAdapter` takes the PostgreSQL client the data layer uses, postgres.js (`cloudflare-postgres`, usually through Hyperdrive) or Bun.SQL; on Workers create that client per request, or per isolate with `max: 1`. Both pass Better Auth's official adapter suite (`@better-auth/test-utils/adapter`). |
| `mantle generate … --auth ./auth.ts` | Adds the tables Better Auth declares for your options (`getSchema`) to `schema.sql`. |
| `@aotter/mantle/generate/auth` | Programmatic `generateFromSources({ target, sources, auth: authOptions, ... })`; the selected entry types `auth` as Better Auth options. |
| `@aotter/mantle/auth` | `authLoader` and `resolveCaller(request, loader, { audience })`: the `Caller` that generated queries take. |

## `auth.ts`

Copy `src/auth.ts` from the [app shell](../../examples/app-shell/README.md), which CI runs from the packed packages.
The application owns Better Auth and its optional plugins. Schema generation reads plain options without constructing
Better Auth; apply `schema.sql` during deployment, never at boot. OAuth resource
rows are created on first OAuth use from runtime configuration; they require no
resource deployment step.

OSS uses `admin({adminRoles: ["admin"], ac, roles: {admin: ac.newRole(defaultStatements), user: ac.newRole({user: [], session: []})}})`.
Mantle reads the official admin plugin’s `adminRoles` when auth loads (default `["admin"]`); it has no role setting of its own. `Caller.role` preserves comma-separated roles and `Caller.admin` carries the layer. A caller holding any configured admin role is an admin; a member’s role names never grant privilege. Publishing, Admin and `/mcp/admin` read this layer. Better Auth still checks permissions for its identity API calls.

`@aotter/mantle/auth/hardening` supplies optional helpers:

- `hashEmailOtp(secret, otp)` is keyed HMAC-SHA-256. Pass it as emailOTP's `storeOTP.hash`; an unkeyed hash permits enumeration of six-digit codes after a database leak.
- `authHardening({ipAddressHeaders, baseURL, errorURL})` refuses missing host-trusted ingress headers and cross-origin error redirects, and enables Better Auth's rate limiter with `storage: "database"`, which the Better Auth docs recommend for serverless: counts are shared across isolates, and Better Auth's defaults and plugin rules (for example 3 per minute per email-OTP path) set the limits. The generated schema includes the `rateLimit` table. Never assume client X-Forwarded-For is trusted.
- `guardGithubLogin(user, context, trustedProviders)` goes in user create/update before-hooks. Only explicitly trusted provider callbacks can populate this field. GitHub maps `githubLogin: profile.login`; generic OAuth ids need trusted profile mappers.
- `withAuthTasks(ctx.waitUntil.bind(ctx), () => auth.handler(request))` retains background sends/cleanup for the current request, with concurrent requests isolated. `authHardening` installs `retainAuthTask` as Better Auth's background handler. Failure logs are generic and contain no OTPs/credentials.
- `authSetupIncomplete()` returns 503/no-store while secrets/providers are unconfigured; do not authenticate by fallback.

Better Auth config is app-owned, so restrict who may sign up (an allowlist, an invitation) with a
`databaseHooks.user.create.before` hook that throws `APIError("FORBIDDEN")` from `better-auth/api` (the app shell calls
`src/signup.ts` there; returning `false` instead breaks email-OTP sign-in in Better Auth 1.7.7, which does not expect a refused create).

Magic links use hashed tokens, 15-minute expiry and the same task retention. Email callbacks pass the first
Accept-Language tag (fallback `en`) to the app's sender. `authRoutes` (as the app shell mounts it) also guards raw Better Auth `/admin/*` routes with the fresh database-backed Caller and the shared session origin check, so a stale KV role cannot bypass the directory gate. Mount that handler when selecting session KV. Configure ordinary Better Auth social providers;
Apple needs `https://appleid.apple.com` trusted origin and secure SameSite=None callback cookies. Generic OAuth login
uses `genericOAuth`, distinct provider ids and discovery or explicit authorization/token URLs. Cookie prefixes,
account linking and trusted origins remain app-owned. Host-only cookies require HTTPS, secure/path=/, a `__Host-`
prefix and no Domain/cross-subdomain sharing.

For OAuth/MCP add `jwt({disableSettingJwtHeader:true})`, official `mcp` plus `cimd` for client metadata discovery,
or `oauthProvider` for ordinary OAuth. These are optional app dependencies behind the dynamic auth import.
Use the live grant/session hooks and route wiring in [OAuth](../guides/oauth.md); merge verification hooks with the app shell's
user hooks. `genericOAuth` is a login plugin, distinct from the OAuth provider.

## Identity helpers

`@aotter/mantle/auth/identity` exports `d1Identity(db, auth, caller, request.headers)` and
`postgresIdentity(sql, auth, caller, request.headers)` (Bun.SQL/postgres.js). Helpers use the template's default
Better Auth table/field names. Every operation requires a current admin cookie session.

Methods: `listUsers()` lists all admin; `listMembers({search,limit,cursor,cursorDirection})` searches id/name/email
(literal LIKE), pages 1–100 and supports forward/backward opaque cursors bound to normalized search;
`setUserRole(id, "admin" | null)`, `inviteUser(email)`, `revokeInvite(id)`, `deleteUser(id)`.
Only identity fields reach outputs, never tokens/internal columns. Self-demotion/deletion is refused. Inviting an existing
member grants admin only after email verification; an unverified existing account is refused. Revocation deletes only an unverified admin invitation with no linked account. Deletion clears OTP
records first and delegates user/session/cache cleanup to Better Auth. Invitation email is an optional email-module step
after success; invitations still work when email is absent.

`d1BootstrapAdmin(db, {match: "email" | "github-login", value}, () => auth)` / `postgresBootstrapAdmin(sql, rule, () => auth)` return
`databaseHooks.user.create.after` (and user.update.after for a later email verification). Only the first matching signup wins (case-insensitive); email matching requires emailVerified=true (required for bootstrap).
D1 uses one conditional UPDATE; PostgreSQL uses a transaction advisory lock before UPDATE, avoiding concurrent winners.
A blocked promotion logs a warning. A GitHub rule requires a configured trusted GitHub provider/profile mapper.
Helpers run no boot queries or DDL.

## Worker entry

Keep auth behind authLoader with a dynamic import of the app-owned auth module. Pass resolveCaller the request, loader, expected MCP audience and outgoing responseHeaders. Preserve returned Set-Cookie headers so sessions can slide. Share a lazy request-local resolver with auth/consent/Admin/MCP/REST; public anonymous routes can avoid auth. See [service composition](service-entry.md) for wiring.

Invalid presented bearer credentials fail rather than becoming anonymous. Fresh session authority comes from Better Auth's primary result; role, ban and revocation checks remain live. Custom cookiePrefix must match the loader; renamed session_token cookie names are refused.

## Build: keep Better Auth out of startup

Use the [Workers build instructions](../../../packages/mantle/README.md#workers-build).
The metafile startup guard rejects static Better Auth imports; keep auth behind
`authLoader(() => import(...))`.

## Schema

`mantle generate <target> <out> <manifest>… --auth ./auth.ts` calls the module's `authOptions` with an empty env
(the tables depend on plugins and options, not env values; nothing is constructed) and appends Better Auth's tables to `schema.sql`. Nothing runs DDL at runtime; migrations
are yours (#1463).

For programmatic auth generation, import `generateFromSources` from
`@aotter/mantle/generate/auth`, not the bare `/generate` entry. Both use the
same generator; the selected entry preserves Better Auth's option types while
bare generation requires no optional auth peer in its public declarations.
Pass plain options rather than constructing Better Auth to obtain the schema.
The CLI's `--auth` selects this path automatically.

Native adapters enable Better Auth joins by default. Without secondaryStorage, fresh cookie authorization uses Better Auth's primary session/user result with disableCookieCache. Passing responseHeaders permits the same call to slide a due cookie. An explicit advanced.database.joins:false retains separate-read behavior. Authority reflects the primary result at that read; a later concurrent revocation applies on the next request.

### Explicit read-only cookie snapshots

Authority remains fresh by default. An application may pass `readOnly: true`
only for a positively classified read. Enable Better Auth's official cache in
app-owned auth options:

```ts
session: {
  cookieCache: { enabled: true, maxAge: 60, refreshCache: false, version: "read-60-v1" },
}
```

A valid signed cache hit avoids Caller DB reads. Missing, tampered, expired or version-mismatched snapshots fall back to primary authority. The SDK accepts this opt-in only without secondaryStorage, with explicit maxAge from 1 to 60 seconds and refreshCache:false. KV gains no cache-authority guarantee; bearer grant checks remain live.

Revocation, bans and role changes reach cached reads within `maxAge` (at most
60 seconds). Sign-out clears both the session-token and cache cookies. Bearer
tokens still use their live grant query on every request.

Generated REST, MCP and web boundaries pass `{ readOnly }` as the third argument
to the application's caller callback. Forward it to `resolveCaller`:

```ts
const caller = (request: Request, _env: Env, authority = { readOnly: false }) =>
  resolveCaller(request, loader, { ...authority, responseHeaders });
```

REST permits cached authority only on GET/HEAD Views; HEAD returns no body.
Web permits it only on GET/HEAD page and index reads. For Cookie requests without
an Authorization header, MCP classifies parsed
`initialize`, `tools/list`, `resources/list`, `resources/read`, generated View
tools and generated native Admin media reads before resolving Caller. Generated
metadata identifies Views versus Procedures; names and `readOnlyHint` annotations
never make a Procedure eligible. A batch uses cached authority only if every
message is a known read. Unknown/malformed methods or tools, mutations,
publishing transitions and Admin writes use fresh authority. Dynamic admin tool
implementations still load only after the admin gate; their read catalogue is
generated separately. App-composed tool tables default to fresh authority, including tools with a
`page` callback or read annotations, unless the
app supplies equivalent trusted read metadata to `mcp`'s fourth argument.

Auth/admin endpoints (including GET) and consent keep the default fresh resolver.
Do not infer authority from HTTP method alone or pass `readOnly: true` for a whole
surface. A caller callback that ignores the third argument retains the default
primary checks. In request-local memoization, keep cached reads separate from
fresh authority so a prior read cannot supply authority for a write.

**Bump `cookieCache.version` when enabling this policy or changing its TTL or
semantics.** A cache minted under an earlier 300-second setting retains its old
signed expiry; changing `maxAge` alone does not shorten it. Better Auth's version
check invalidates that snapshot. The SDK cannot infer prior deployment config.
Sign-out clears the session-token and cache cookies; pass SDK Set-Cookie headers
through to the browser. A copied pre-sign-out cookie can remain usable for
read-only snapshots until TTL, while fresh authority rejects revoked sessions.

With secondaryStorage, disableCookieCache does not bypass KV. Caller keeps a primary authority check before any second SDK call refreshes/forwards cookies. Stale snapshots cannot revive deleted/expired primary sessions or retain obsolete role/ban state.

`authRoutes` may be imported statically: its consent/provider integration loads
only for a matching consent request, after Caller/origin/body guards. Optional
Better Auth adapter code stays outside the Worker startup graph.

`@aotter/mantle/auth/admin` exports `guardAuthAdminRequest(request, resolveFreshCaller, basePath?)` for selected auth transports. It resolves authority only for raw/encoded admin paths, requires an admin cookie session and checks mutation origin. Both the app-owned template and OAuth routes use this same guard.

`ctx.admin` role names are open and must match `^[a-z][a-zA-Z0-9_]{0,62}$`. Bare `ctx.admin` admits any admin; a list admits admins holding one of its roles. Better Auth’s `adminRoles` decides who is an admin. Member role names alone grant no privilege.

The generated auth DDL adds a native `(createdAt, id)` member-paging index (respecting schema field/table names). Unfiltered forward/backward paging orders native timestamps through that index; PostgreSQL cursors retain all six fractional digits and bind as text before timestamp casting. Member search (`%term%` over id/name/email, casting UUID ids to text only in the search expression) is a full scan; the index does not accelerate it.

## Several Better Auth instances in one app

The default is one instance with `admin` and `user` roles. An app that keeps two populations apart (for example
staff and customers) can run one Better Auth instance per population in the same Worker; every Mantle primitive
takes the instance it works on:

- Give each instance its own `basePath`, `advanced.cookiePrefix`, `secret` and table names (`user.modelName`,
  `session.modelName`, ... and plugin `schema` options). Keep each instance's options in its own module and pass
  one `--auth` per module to `mantle generate`; the tables are merged into one migration, and two instances that
  define the same table differently are refused. The native adapter follows each instance's mapping.
- One `authLoader(load, cookiePrefix)` per instance; call `resolveCaller(request, loader)` with the instance the
  route belongs to, and mount `authRoutes(loader, ...)` per instance (it guards that instance's `/admin/*`). The
  loader takes `cookiePrefix` separately on purpose: it checks the cookie before loading Better Auth, so anonymous
  requests never pay for it. Read both from one constant.
- Admin signs in with the instance passed to `adminShell(request, assets, { authBasePath })`; its identity
  directory is the instance you pass to `d1Identity` / `postgresIdentity`.
