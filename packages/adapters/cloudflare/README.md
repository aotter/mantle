# @aotter/mantle-cloudflare

Cloudflare Workers adapter for mantle.

Documentation paths beginning with `node_modules/` below are relative to the
application root. Shared guides ship in the same-version `@aotter/mantle`
package; in an SDK checkout, those guides live under the root `docs/`.

This package mounts the runtime on Hono, implements the runtime ports against
Cloudflare D1 / KV / Workers assets, and owns curated identity/session wiring
plus MCP OAuth/CIMD. Legacy DCR remains a bounded compatibility path.

This package is prerelease software. Its `package.json` is the exact version
authority; the API surface may change until the first stable `0.1.2` release.

## Conventional Worker Facade

`createMantleWorker({ plan })` is the normal assembly path. It composes the
adapter's existing Auth, binding, Hono, OAuth and MCP primitives once per
isolate; `extend` may add application routes but cannot replace Core-owned
paths. The canonical contract and reserved path list live in the umbrella
package's `node_modules/@aotter/mantle/README.md` (“Conventional Cloudflare Worker”)
section.

The returned facade also exposes `getRuntime(env)`. Site-owned Queue and
scheduled handlers use it with generated `bindMantle(...)` Procedures so
they reuse the fetch path's assembled runtime instead of writing directly to
Mantle tables. Queue handlers still own per-message acknowledgement, retry,
and idempotency.

### Conventional Auth

Without an `auth` option, `createMantleWorker` requires one explicit mode:

| Mode | Non-secret bindings | Worker secrets | Must be absent |
|---|---|---|---|
| `self-managed` | `MANTLE_AUTH_MODE=self-managed`, `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`, `ADMIN_GITHUB_LOGIN` | `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` | `MANTLE_HOSTED_AUTH_ISSUER`, `MANTLE_HOSTED_AUTH_CLIENT_ID` |
| `hosted` | `MANTLE_AUTH_MODE=hosted`, `PUBLIC_ORIGIN`, `MANTLE_HOSTED_AUTH_ISSUER`, `MANTLE_HOSTED_AUTH_CLIENT_ID`, `ADMIN_GITHUB_LOGIN` | `BETTER_AUTH_SECRET` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

Hosted Auth is a public PKCE client with no client secret. Its issuer must be
an HTTPS root origin (HTTP is accepted only for loopback development), and the
client id must be a URL at the same origin with the shape `/clients/<id>`.
Invalid, partial, or mixed-mode configuration fails closed: public site routes
remain available, while Admin, Auth, OAuth, and MCP routes return
`503 setup_incomplete`.

MCP client metadata is fetched through the public Internet boundary. Keep both
flags in `wrangler.jsonc`:

```jsonc
"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]
```

Sites with a different identity design may preserve Core's route ownership
while replacing only construction:

```ts
createMantleWorker({
  plan,
  auth: (env) => createAuth({ /* curated site-specific methods */ }),
});
```

When the conventional lifecycle really does not fit, copy the
`node_modules/@aotter/mantle/docs/handbook/cloudflare/low-level-composition.md`.
It uses the same public bindings, Auth, runtime, OAuth/MCP, cache and error
primitives as the facade, and states which code becomes application-owned.

## Better Auth Boundaries

`createAuth()` exposes curated Better Auth configuration fields, not a
generic Better Auth passthrough. The hosted-auth and self-hosted-auth
product boundary is documented in
`node_modules/@aotter/mantle/docs/auth-hosting-model.md`.

For trusted first-party apps that share one parent domain, configure
same-parent-domain cookies explicitly:

```ts
const auth = createAuth({
  database: env.DB,
  baseURL: "https://platform.mantle.tools",
  secret: env.BETTER_AUTH_SECRET,
  methods,
  trustedOrigins: ["https://mantle.tools", "https://www.mantle.tools"],
  cookiePrefix: "mantle-platform",
  crossSubDomainCookies: {
    enabled: true,
    domain: "mantle.tools",
  },
});
```

Use `crossSubDomainCookies` only when the same party controls every
participating subdomain. For a customer-owned domain such as
`customer.com`, use an OAuth/OIDC broker flow instead of shared cookies.

## API and MCP Authorization

`createMantleRuntimeRef()` accepts an optional `credentialResolver` for site-owned API
keys and personal tokens, plus optional `jwtBearer` verification for
manifest REST routes. The adapter normalizes those callers, cookie sessions,
and MCP OAuth callers into the same runtime auth context. Manifest
`ctx.auth`/scope predicates and `guard.procedure` then enforce the target on
every REST or MCP call.

Core does not create credential or payment tables. See the shipped
`node_modules/@aotter/mantle/docs/api-mcp-authorization.md` for
the exact resolver contract, OAuth resource helpers, manifest examples,
status behavior, OpenAPI reflection, and runnable integration fixture.

### Optional MCP catalog KV projection

Bind a deployment-owned KV namespace as `MANTLE_KV` to avoid a D1 site-settings
read while assembling each authenticated MCP tool catalog:

```toml
[[kv_namespaces]]
binding = "MANTLE_KV"
id = "<production-namespace-id>"
preview_id = "<development-namespace-id>"
```

D1 remains canonical. Runtime preparation and Admin site-setting mutations
write the caller-independent catalog projection (brand, description, origin,
icons, and media-purpose policy) to KV after the D1 write commits. Missing,
invalid, or expired snapshots are repaired from D1; KV failures do not turn a
committed setting change into a failed request. Tokens, sessions, caller data,
operator-only settings, and content are never stored in this projection.
All Cloudflare locations follow Workers KV's eventual-consistency model while
a write propagates; the one-hour repair deadline prevents an observation from
remaining authoritative indefinitely.

`createConventionalBindings(env)` detects `MANTLE_KV` automatically. Low-level
bindings may instead set `mcpCatalogKv: { namespace, scope }`; the scope must be
a stable deployment-owned identifier and must never be derived from a request.

The shared SQLite storage accepts a `decorateSiteConfigRepository` hook; KV
serialization and consistency policy belong to this Cloudflare decorator, not
the runtime. Other adapters can decorate their repositories with their own
cache implementation. Ordinary site-config, locale, and upload-policy reads
still delegate to canonical storage; only MCP discovery uses the snapshot.

Direct SQL edits bypass publication. After an out-of-band edit, call the
decorated repository's `seed(undefined)` to republish persisted state, or allow
the snapshot's one-hour repair deadline to trigger a reload on the next MCP
request. Publication failure leaves D1 authoritative and does not suppress the
public-cache purge.

## HTTP Dispatch Benchmark

Run the warm, in-process View and Procedure transport benchmark with:

```sh
pnpm --filter @aotter/mantle-cloudflare bench:http-dispatch
```

It includes Hono routing, one caller resolution, auth and scope checks,
compiled-schema validation, a dynamic guard, an in-memory query or handler,
and response-envelope serialization. On Node 22+, the expected warm p50 is
below 0.1 ms for each route. In a same-machine Wrangler comparison, Mantle's
fixed p50 overhead over an equivalent handwritten route should stay below
1 ms. Compare alternating warm runs on the same machine; these are regression
budgets, not production latency promises, because D1 and credential I/O
usually dominate the total request time.

## HTTP Cache Boundary

The conventional facade applies the final cache policy after Better Auth,
MCP, Admin, manifest, and application routing. Low-level composition must call
the exported `applyCachePolicy(...)` at the same final boundary. It marks
admin, auth, API, OAuth, MCP, redirects, and errors `private, no-store` and
removes Cloudflare CDN cache overrides. Only anonymous 200 `GET`/`HEAD`
responses that explicitly declare `public` plus shared freshness remain
cacheable; they vary on `Cookie` and `Authorization`.

`mountPublicRoutes(...)` renders D1-backed HTML, markdown, `llms.txt`, and
sitemap responses with that explicit public contract and one `mantle-public`
Cache-Tag. Publishing-content and site-setting mutations purge that tag through
the native Workers cache API; immutable assets and operational records stay
outside the purge boundary. Workers Cache stores only responses that still
satisfy the anonymous policy, and remains version-local. See the
`node_modules/@aotter/mantle/docs/adapter-guide.md` (“HTTP cache contract”).

## Optional R2 Media Uploads

R2-backed staff media uploads are adapter-specific post-launch work, not part
of the Core SDK skill contract or Day 1 landing path. Use the Cloudflare recipe
only when a site actually needs staff-managed images or files:

`node_modules/@aotter/mantle/docs/handbook/cloudflare/media-r2.md`

## Optional deferred lifecycle hooks

`WorkersQueueHookDispatcher` and `createQueueHandler` opt `after_*` lifecycle
Triggers into Cloudflare Queues. Delivery is at-least-once, not exactly-once;
the D1 write and Queue send are not atomic, and fallback through `waitUntil` is
best-effort. Handlers receive a stable `ctx.event.id` plus
`ctx.event.trigger` for idempotency. The adapter validates strict v1 JSON
envelopes, reserves metadata headroom under Cloudflare's 128 KB message limit,
and maps failures to per-message retry/DLQ behavior.

Producer/consumer bindings, Worker export, idempotent D1/upstream examples,
site-queue multiplexing, verification, and the legacy-envelope drain step are
in the shipped
`node_modules/@aotter/mantle/docs/handbook/cloudflare/deferred-hooks-queues.md`.
