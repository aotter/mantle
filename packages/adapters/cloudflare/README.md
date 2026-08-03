# @aotter/mantle-cloudflare

Cloudflare Workers adapter for mantle.

This package mounts the runtime on Hono, implements the runtime ports against
Cloudflare D1 / KV / Workers assets, and owns Better Auth wiring for GitHub
OAuth plus MCP OAuth/DCR.

`0.0.7-alpha` is an early prerelease for the agent-provisioning proof. The API
surface remains in flux until `v0.1.0`.

## Conventional Worker Facade

`createMantleWorker({ manifest })` is the normal assembly path. It composes the
adapter's existing Auth, binding, Hono, OAuth and MCP primitives once per
isolate; `extend` may add application routes but cannot replace Core-owned
paths. The canonical contract and reserved path list live in the umbrella
package's [Conventional Cloudflare Worker](../../mantle/README.md#conventional-cloudflare-worker)
section.

When the conventional lifecycle really does not fit, copy the
[low-level composition fixture](../../../docs/cloudflare-low-level-composition.md).
It uses the same public bindings, Auth, runtime, OAuth/MCP, cache and error
primitives as the facade, and states which code becomes application-owned.

## Better Auth Boundaries

`createAuth()` exposes curated Better Auth configuration fields, not a
generic Better Auth passthrough. The hosted-auth and self-hosted-auth
product boundary is documented in
[`docs/auth-hosting-model.md`](../../../docs/auth-hosting-model.md).

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

`createCmsRef()` accepts an optional `credentialResolver` for site-owned API
keys and personal tokens, plus optional `oauthBearer` JWT verification for
manifest REST routes. The adapter normalizes those callers, cookie sessions,
and MCP OAuth callers into the same runtime auth context. Manifest
`ctx.auth`/scope predicates and `guard.procedure` then enforce the target on
every REST or MCP call.

Core does not create credential or payment tables. See the shipped
[API and MCP authorization guide](../../../docs/api-mcp-authorization.md) for
the exact resolver contract, OAuth resource helpers, manifest examples,
status behavior, OpenAPI reflection, and runnable integration fixture.

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

Export `createOAuthProvider(...)` as the Worker's top-level handler. It marks
admin, auth, API, OAuth, MCP, redirects, and errors `private, no-store` and
removes Cloudflare CDN cache overrides. Only anonymous 200 `GET`/`HEAD`
responses that explicitly declare `public` plus shared freshness remain
cacheable; they vary on `Cookie` and `Authorization`.

`mountPublicRoutes(...)` applies that explicit public contract to pre-rendered
HTML, markdown, `llms.txt`, and sitemap responses. A consumer Workers Cache may
store only responses that still satisfy the contract. See the
[adapter implementation guide](../../../docs/adapter-guide.md#http-cache-contract).

## Optional R2 Media Uploads

R2-backed staff media uploads are adapter-specific post-launch work, not part
of the Core SDK skill contract or Day 1 landing path. Use the Cloudflare recipe
only when a site actually needs staff-managed images or files:

<https://raw.githubusercontent.com/aotter/mantle/develop/docs/media-uploads.md>

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
[deferred lifecycle Queue guide](../../../docs/deferred-lifecycle-queues.md).
