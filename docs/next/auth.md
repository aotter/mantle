# Auth in Mantle

Your application configures `betterAuth()` and its official plugins in `auth.ts`.
Mantle supplies the database adapter, schema generation and caller resolution:

| Mantle | What it does |
| --- | --- |
| `@aotter/mantle/auth/adapter` | `d1Adapter(env.DB)` / `bunSqlAdapter(sql)`: Better Auth's `database` on the same native handle as your data, no Kysely. Passes Better Auth's official adapter suite (`@better-auth/test-utils/adapter`). |
| `mantle generate … --auth ./auth.ts` | Adds the tables Better Auth declares for your options (`getSchema`) to `schema.sql`. |
| `@aotter/mantle/generate/auth` | Programmatic `generateFromSources({ target, sources, auth: authOptions, ... })`; the selected entry types `auth` as Better Auth options. |
| `@aotter/mantle/auth` | `authLoader` and `resolveCaller(request, loader, { audience })`: the `Caller` that generated queries take. |

## `auth.ts`

Use the [complete, typechecked D1 template](../../packages/mantle/tests/apps/auth/template.ts).
The application owns Better Auth and its optional plugins. Schema generation reads plain options without constructing
Better Auth; apply `schema.sql` during deployment, never at boot.

OSS uses `admin({adminRoles: ["staff"], ac, roles: {staff: ac.newRole(defaultStatements), user: ac.newRole({user: [], session: []})}})`.
**Any staff can manage users in OSS.** `Caller.role` preserves every application role string; the OSS publishing
allowlist contains only `staff`. Cloud permissions/organizations remain separate.

`@aotter/mantle/auth/hardening` supplies optional helpers:

- `hashEmailOtp(secret, otp)` is keyed HMAC-SHA-256. Pass it as emailOTP's `storeOTP.hash`; an unkeyed hash permits enumeration of six-digit codes after a database leak.
- `authHardening({ipAddressHeaders, baseURL, errorURL, plugins})` refuses missing host-trusted ingress headers and cross-origin error redirects. Rate limits are derived from the actual configured plugin ids: 10/min for emailOTP or magicLink, otherwise 100/min, per isolate. Use ingress limits for distributed quotas; never assume client X-Forwarded-For is trusted.
- `guardGithubLogin(user, context, trustedProviders)` goes in user create/update before-hooks. Only explicitly trusted provider callbacks can populate this field. GitHub maps `githubLogin: profile.login`; generic OAuth ids need trusted profile mappers.
- `withAuthTasks(ctx.waitUntil.bind(ctx), () => auth.handler(request))` retains background sends/cleanup for the current request, with concurrent requests isolated. `authHardening` installs `retainAuthTask` as Better Auth's background handler. Failure logs are generic and contain no OTPs/credentials.
- `sessionSecondaryStorage(cache, deploymentNamespace, () => auth.$context)` requires a bound primary database context and a unique namespace per deployment/database. Keep `session.storeSessionInDatabase` and `verification.storeInDatabase` true (enforced). The adapter reads live session/user rows through Better Auth's own adapter, and rebuilds its active-session index from the database. KV snapshot/index writes are best effort; stale or unavailable KV never supplies authorization or hides sessions from listing. This seam is an optional replica, **not an authorization fast path**: primary DB reads remain required. Verification consumption and atomic counters never use KV.
- `authSetupIncomplete()` returns 503/no-store while secrets/providers are unconfigured; do not authenticate by fallback.

Magic links use hashed tokens, 15-minute expiry and the same task retention. Email callbacks pass the first
Accept-Language tag (fallback `en`) to the app's sender. The template's app-owned `handleAuth` also guards raw Better Auth `/admin/*` routes with the fresh database-backed Caller and the shared session origin check, so a stale KV role cannot bypass the directory gate. Mount that handler when selecting session KV. Configure ordinary Better Auth social providers;
Apple needs `https://appleid.apple.com` trusted origin and secure SameSite=None callback cookies. Generic OAuth login
uses `genericOAuth`, distinct provider ids and discovery or explicit authorization/token URLs. Cookie prefixes,
account linking and trusted origins remain app-owned. Host-only cookies require HTTPS, secure/path=/, a `__Host-`
prefix and no Domain/cross-subdomain sharing.

For OAuth/MCP add `jwt({disableSettingJwtHeader:true})`, official `mcp` plus `cimd` for client metadata discovery,
or `oauthProvider` for ordinary OAuth. These are optional app dependencies behind the dynamic auth import.
Use the live grant/session hooks and route wiring in [OAuth](oauth.md); merge verification hooks with the template's
user hooks. `genericOAuth` is a login plugin, distinct from the OAuth provider.

## Identity helpers

`@aotter/mantle/auth/identity` exports `d1Identity(db, auth, caller, request.headers)` and
`postgresIdentity(sql, auth, caller, request.headers)` (Bun.SQL/postgres.js). Helpers use the template's default
Better Auth table/field names. Every operation requires a current staff cookie session.

Methods: `listUsers()` lists all staff; `listMembers({search,limit,cursor,cursorDirection})` searches id/name/email
(literal LIKE), pages 1–100 and supports forward/backward opaque cursors bound to normalized search;
`setUserRole(id, "staff" | null)`, `inviteUser(email)`, `revokeInvite(id)`, `deleteUser(id)`.
Only identity fields reach outputs, never tokens/internal columns. Self-demotion/deletion is refused. Inviting an existing
member grants staff only after email verification; an unverified existing account is refused. Revocation deletes only an unverified staff invitation with no linked account. Deletion clears OTP
records first and delegates user/session/cache cleanup to Better Auth. Invitation email is an optional email-module step
after success; invitations still work when email is absent.

`d1BootstrapStaff(db, {match: "email" | "github-login", value})` / `postgresBootstrapStaff(sql, rule)` return
`databaseHooks.user.create.after` (and user.update.after for a later email verification). Only the first matching signup wins (case-insensitive); email matching requires emailVerified=true (stricter than 0.2's bootstrap).
D1 uses one conditional UPDATE; PostgreSQL uses a transaction advisory lock before UPDATE, avoiding concurrent winners.
A blocked promotion logs a warning. A GitHub rule requires a configured trusted GitHub provider/profile mapper.
Helpers run no boot queries or DDL.

## Worker entry

```ts
import { authLoader, resolveCaller } from "@aotter/mantle/auth";
import { views } from "./generated/generated.js";

let auth: ReturnType<typeof authLoader> | undefined;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // import(): Better Auth stays out of the entry module (see Build)
    auth ??= authLoader(() => import("./auth.js").then(m => m.createAuth(env)));
    const url = new URL(request.url);
    if (url.pathname === "/catalog") return Response.json(await views.catalog(env.DB, { kind: "anonymous" }, {})); // public: no auth at all
    if (url.pathname.startsWith("/api/auth/")) return (await import("./auth.js")).handleAuth(await auth.get(), request, ctx.waitUntil.bind(ctx));
    const headers = new Headers(); // receives a refreshed session cookie, so the session slides
    const caller = await resolveCaller(request, auth, { audience: `${env.ORIGIN}/mcp`, responseHeaders: headers });
    // … generated Views and Procedures with `caller`, then: return Response.json(result, { headers })
  },
};
```

`resolveCaller` uses Better Auth's session and adapter APIs. With no credentials it never loads Better Auth. A session cookie is
validated by `auth.api.getSession` without the cookie cache, so revocation and role changes apply on the next request.
A `Bearer` access token is verified by the official resource client for `audience`, and the user (role, ban) is read
from the database on every request. An invalid token is `UNAUTHENTICATED`, never anonymous. Public routes must not call it.

If you set `advanced.cookiePrefix`, pass the same value: `authLoader(load, "app")`. A renamed
`advanced.cookies.session_token.name` is refused, because Better Auth's `getSessionCookie` cannot find it.

## Build: keep Better Auth out of startup

Workers compiles an uploaded module only when it is imported. Better Auth in its own module therefore costs a cold
isolate nothing until a request needs it. Measured on production Workers (#1462), startup was 1 ms instead of 77 ms
eager or 32 ms for `import()` inside one bundle.
Follow the [Workers build instructions](../../packages/mantle/README.md#workers-build).
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

The native auth adapters enable database joins by default; an explicit
`advanced.database.joins: false` retains Better Auth's separate-read fallback.
Without `secondaryStorage`, cookie authorization trusts Better Auth's
`getSession({ query: { disableCookieCache: true } })` primary session/user result:
**one native joined read**, with no additional Caller read. Passing
`responseHeaders` lets that same SDK call slide a due cookie; it adds one UPDATE
and no extra read. An explicit `advanced.database.joins: false` instead needs
Better Auth's two separate reads. Authority is the primary result at that read;
a concurrent revocation afterward applies on the next request. Role changes,
bans, user/session deletion and expiry already present in the primary are
reflected immediately.

### Explicit read-only cookie snapshots

Authority remains fresh by default. An application may pass `readOnly: true`
only for a positively classified read. Enable Better Auth's official cache in
app-owned auth options:

```ts
session: {
  cookieCache: { enabled: true, maxAge: 60, refreshCache: false, version: "read-60-v1" },
}
```

A valid signed cache hit uses **zero Caller DB reads**, both on the first
resolution and a warm repeat. Missing, tampered, expired or version-mismatched
cache falls back to Better Auth's primary read (one joined read; two with joins
explicitly disabled). Better Auth owns signatures, expiry and cache cookies.
The opt-in only takes effect without `secondaryStorage`, with explicit
`maxAge` from 1 to 60 seconds and `refreshCache: false`; otherwise authority
stays fresh. KV does not gain a zero-read guarantee. Bearer grant checks are
unchanged regardless of this option.

Revocation, bans and role changes can reach cached reads as late as the cache
TTL. Every mutation and authority-sensitive endpoint must keep the default:
auth/admin (including GET), consent, publishing, ref Procedures, media and
unknown operations. HTTP method alone does not classify a read; MCP read tools
also use POST. Never assign `readOnly: true` to the entire REST or MCP surface.
For example, an app that owns these exact generated View paths can use:

```ts
const readViews = new Set(["/api/views/articles", "/api/views/profile"]);
const caller = (request: Request) => resolveCaller(request, loader, {
  readOnly: ["GET", "HEAD"].includes(request.method) && readViews.has(new URL(request.url).pathname),
});
```

Web page reads can opt in where the app knows it is rendering a declared View.
MCP must classify parsed `initialize`, `tools/list` and known View tools before
Caller resolution; a handler that resolves Caller before parsing has no such
seam and stays fresh. Mixed batches and unknown tools stay fresh. No claim of
zero MCP DB reads applies until that integration is present.

**Bump `cookieCache.version` when enabling this policy or changing its TTL or
semantics.** A cache minted under an earlier 300-second setting retains its old
signed expiry; changing `maxAge` alone does not shorten it. Better Auth's version
check invalidates that snapshot. The SDK cannot infer prior deployment config.
Sign-out clears the session-token and cache cookies; pass SDK Set-Cookie headers
through to the browser. A copied pre-sign-out cookie can remain usable for
read-only snapshots until TTL, while fresh authority rejects revoked sessions.

With `secondaryStorage`, `disableCookieCache` does not bypass KV. The first
session call disables refresh, and Caller keeps a joined primary authority check
before any second SDK call may refresh or forward cookies. A plain KV hit uses
one primary read plus the KV lookup; cache misses and emulated joins cost more.
The optional `sessionSecondaryStorage` also checks primary authority on lookup:
it uses **two primary reads** for Caller without `responseHeaders`, or three
with headers when no refresh is due. A due refresh with that adapter uses five reads (the initial authority read, Caller guard,
second SDK lookup, and Better Auth's own update/index reads) plus one UPDATE.
These existing KV costs are retained rather than replacing Better Auth's signed
cookie and refresh implementation. Stale snapshots cannot revive expired or
deleted primary sessions or retain obsolete staff/ban state. Missing KV session
indexes still rebuild from primary storage; SDK listing cost is unchanged.

`authRoutes` may be imported statically: its consent/provider integration loads
only for a matching consent request, after Caller/origin/body guards. Optional
Better Auth adapter code stays outside the Worker startup graph.

`@aotter/mantle/auth/admin` exports `guardAuthAdminRequest(request, resolveFreshCaller, basePath?)` for selected auth transports. It resolves authority only for raw/encoded admin paths, requires a staff cookie session and checks mutation origin. Both the app-owned template and OAuth routes use this same guard.

SDK session listing performs one active-index read plus one joined read per live
session (N+1; two sessions use three reads). It has the SDK's full-list semantics,
so apps with many sessions should account for that read cost.

Next's currently generated role vocabulary is `staff`. Generation rejects owner/editor/contributor in `ctx.staff`; migrate those 0.2 user roles and requires declarations to `staff`, or retain them in Cloud's explicit role sets. Caller.role remains an open string for application-owned ordinary roles; this does not add generated staff permissions for those names.

The generated auth DDL adds a native `(createdAt, id)` member-paging index (respecting schema field/table names). Unfiltered forward/backward paging orders native timestamps through that index; PostgreSQL cursors retain all six fractional digits and bind as text before timestamp casting. Member search (`%term%` over id/name/email, casting UUID ids to text only in the search expression) is a full scan; the index does not accelerate it.
