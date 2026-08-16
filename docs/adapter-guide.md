# Adapter implementation guide

This guide is the fresh-developer entry point for implementing a new mantle platform adapter.

Read this with [ADR-0019](adr/0019-sealed-manifest-runtime-pipeline.md). The source of truth for TypeScript shapes is `packages/mantle-runtime/src/domain/port/`.

Adapter packages live under `packages/adapters/<platform>/` using a plural `adapters` bucket. The npm package names stay unchanged, for example `@aotter/mantle-cloudflare`. Keep adapters in this monorepo until the runtime/spec API is stable enough that coordinated releases across separate repositories would not create version skew for starters.

## Required storage boundary

A storage adapter prepares one `RuntimePlan` into semantic ports:

| Contract | Source | Cloudflare example |
|---|---|---|
| `MantleStorageAdapter` / `PreparedMantleStorage` | `packages/mantle-runtime/src/domain/port/MantleStorageAdapter.ts` | `SqliteMantleStorageAdapter` over `D1DatabaseDriver` |
| `EntryRepository & EntryReader` | Existing semantic content ports | `DatabaseEntryRepository` supplied by the SQLite adapter |
| `ViewQueryExecutor` | `packages/mantle-runtime/src/domain/port/ViewQueryExecutor.ts` | `SqliteViewQueryExecutor` |

`DatabaseDriver` is only the reusable SQLite/D1 implementation seam. A
PostgreSQL, MongoDB, or application-owned-table adapter implements the semantic
ports directly; it does not emulate D1 and needs no mapping DSL. Platform types
such as `D1Database`, Postgres pools, and Mongo clients remain in adapter code.

## Optional capabilities

Optional ports are enabled only when a feature needs them:

| Contract | Source | Required when |
|---|---|---|
| `MediaStorage` | `packages/mantle-runtime/src/domain/port/MediaStorage.ts` | The adapter exposes admin/MCP media upload flows. |
| `DeferredHookDispatcher` | `packages/mantle-runtime/src/domain/port/DeferredHookDispatcher.ts` | The adapter wants at-least-once queue delivery for `after_*` lifecycle hooks. |

Test seams such as `Clock` and `IdGenerator` are injectable through `createCmsRuntime`, but normal adapters do not need custom implementations.

Deferred delivery is an optional, versioned wire contract. Queue acceptance is
not atomic with the entry write; adapters must preserve the supplied event id,
validate untrusted messages before dereferencing them, surface handler failures
to their retry mechanism, and document poison-message/DLQ behavior. See
[Deferred lifecycle hooks on Cloudflare Queues](deferred-lifecycle-queues.md)
for the reference implementation and exact guarantees.

## Storage preparation

Compile before deployment preparation, then pass only the sealed plan:

```ts
import {
  createMantleRuntime,
  prepareDeployment,
  SqliteMantleStorageAdapter,
} from "@aotter/mantle-runtime";

const storage = new SqliteMantleStorageAdapter(db, siteDefaults);
const prepared = await prepareDeployment(plan, storage, {
  handlerNames: Object.keys(handlers ?? {}),
  reservedHttpPathPrefixes: selectedCapabilities.flatMap(
    (capability) => capability.reservedHttpPathPrefixes,
  ),
});
const runtime = createMantleRuntime({
  plan,
  prepared,
  handlers,
});
```

The official SQLite adapter runs canonical migrations, defaults, indexes, and
schema-View reconciliation, and skips mutation for an unchanged revision. A
custom adapter owns its own preparation and returns application-owned semantic
ports. Unsupported native View dialects fail before the adapter mutates state.

The alpha.7 `await createCmsRuntime({ manifests, db, assets })` API is a
one-way full-product compatibility facade over these stages until #673. New
adapter code should use the sealed inputs above.

## HTTP and MCP surfaces

The runtime is a library, not an HTTP server. A new adapter must mount equivalent framework routes:

| Surface | Adapter responsibility | Cloudflare reference |
|---|---|---|
| Public/admin HTTP endpoints | Route HTTP Triggers, View REST endpoints, admin SPA assets, and public render routes into runtime use cases. | `packages/adapters/cloudflare/src/mount/mountServerEndpoints.ts`, `mountPublicRoutes.ts` |
| Auth endpoints | Own sign-in/session/OAuth metadata routes through the adapter's Better Auth integration. | `packages/adapters/cloudflare/src/auth/createAuth.ts`, `mountServerEndpoints.ts` |
| MCP endpoints | Mount `/mcp/staff` and `/mcp` via `createOAuthProvider({ apiHandlers })`; the OAuth lib verifies bearer tokens against its KV grant store, then calls the matching apiHandler with `ctx.props` set. The adapter enforces the staff D1 role inside the apiHandler, then dispatches JSON-RPC. | `packages/adapters/cloudflare/src/mount/mountMcp.ts`, `oauth/oauthSingleton.ts`, `oauth/mountOAuth.ts` |

Auth is not a runtime port. Per [ADR-0014](adr/0014-auth-better-auth-and-multi-tenant-mcp.md), the adapter owns Better Auth wiring and passes authenticated user/staff context into runtime dispatchers. Procedure handlers receive that data through `HandlerContext` in `packages/mantle-runtime/src/domain/model/HandlerContext.ts`.

The adapter must also normalize verified credential metadata into
`HandlerContext.auth` (`credential`, opaque `credentialId`, optional
`clientId`, scopes). Platform-native session/OAuth verification stays in the
adapter. A narrow adapter extension seam may let consumer code verify its own
API-key or personal-token formats, but credential storage/issuance must not
become a runtime port. The Cloudflare reference is
`mount/resolveCaller.ts`; consumer usage is documented in
[API and MCP authorization](api-mcp-authorization.md).

Minimum HTTP behavior for a full adapter:

- Route manifest HTTP Triggers to `runtime.invokeProcedure`.
- Route `GET /api/views/<name>` to `runtime.executeView`.
- Mount admin content APIs with session/role checks before calling runtime content use cases.
- Serve admin SPA assets through `AssetServer`, with an SPA catchall for admin client-side routes.
- Mount public render routes and markdown mirrors when the starter exposes public pages.
- Translate runtime diagnostics and validation failures into stable HTTP JSON responses instead of throwing raw errors.
- Evaluate target auth and dynamic guards through the runtime use cases; do
  not duplicate guard logic in HTTP handlers.

For the Cloudflare adapter, public rendering requires three matching consumer
inputs: `mountPublicRoutes(...)` route declarations, a `TemplateRegistry`
passed through `CmsConfig.templates`, and a `publicPathResolver` passed through
`CmsConfig.publicPathResolver`. Omitting public routes is valid for a headless
consumer; mounting every Schema automatically is not, because some collections
are private even when they contain a slug.

`TemplateRegistry` and `createPublicPathResolver` come from
`@aotter/mantle-web`. Other adapters can call `createMantleWeb(runtime)` and map
its document operations into their own routing and cache conventions.

### HTTP cache contract

The Cloudflare adapter is private by default. Consumers must export
`createOAuthProvider(...)` as the Worker's top-level handler so its final
response policy covers admin, auth, API, OAuth, MCP, redirects, and errors.
Those responses receive `Cache-Control: private, no-store`; Cloudflare-specific
CDN cache overrides are removed.

`mountPublicRoutes(...)` renders canonical D1 state and opts only successful HTML, markdown,
`llms.txt`, and sitemap responses into the shared cache with
`Cache-Control: public, max-age=0, s-maxage=300` and the site-level
`Cache-Tag: mantle-public`. The top-level policy preserves
that opt-in only for anonymous `GET`/`HEAD` responses with status 200, explicit
shared freshness, no request `Cookie` or `Authorization`, and no response
`Set-Cookie`. It also varies public responses by `Cookie` and `Authorization`.

A starter-level Workers Cache may therefore store only responses that still
meet that exact public contract. It must bypass credentialed/cookie requests
and must never infer cacheability from a URL prefix. Cache entries remain
version-local; cross-version caching is outside this contract. Successful
publishing-content and site-setting mutations purge `mantle-public` through
Cloudflare's native cache API. Operational records and immutable assets do not
purge the public render cache.

Minimum auth/MCP behavior:

- Provide Better Auth-compatible sign-in/session routes for the platform.
- Validate `/mcp/staff` requests with the staff D1 admin role (`owner`/`editor`/`contributor`).
- Validate `/mcp` requests with any authenticated session (D1 role check is surface-driven, not OAuth-scope-driven — claude.ai rejects colon-shaped scopes).
- Advertise a single non-colon scope (default `["mcp"]`) in `scopes_supported`. Per-surface enforcement happens server-side in the apiHandler.
- Build `McpAuthContext` from the validated session and pass it to `McpJsonRpcDispatcher`.
- Build Procedure/View `HandlerContext` with `user`, live `staff`, normalized
  `auth`, adapter `env`, and optional `waitUntil`.
- Re-read mutable staff role for each protected REST/MCP invocation. Token or
  consent-time role snapshots are not an authorization boundary.
- Keep `tools/list` filtering as UX only; route every `tools/call` through the
  same auth evaluator and guard runner used by REST.

## Static assets

`AssetServer` belongs to the alpha.7 full-facade compatibility path. A selected
Admin module must have an asset strategy, but headless Core storage preparation
does not require assets. Admin extraction is completed in issue #670.

## Implementation checklist

- [ ] Implement `MantleStorageAdapter` returning existing semantic ports, or reuse `SqliteMantleStorageAdapter` with an already-owned handle.
- [ ] Call `prepareDeployment()` once per semantic revision before binding runtime.
- [ ] Mount HTTP Trigger and View REST surfaces.
- [ ] Mount admin/public render routes and admin SPA assets.
- [ ] Provide adapter-owned Better Auth wiring and session helpers.
- [ ] Normalize session/OAuth and any consumer credential seam into
      `HandlerContext.auth`; never put raw credentials in runtime context.
- [ ] Mount `/mcp/staff` and `/mcp` via the platform's OAuth provider lib (Cloudflare adapter uses `@cloudflare/workers-oauth-provider` at top level). Enforce staff D1 role inside the apiHandler.
- [ ] Preserve the HTTP cache contract: private by default; explicit anonymous 200 `GET`/`HEAD` public opt-in only.
- [ ] Prove one guarded target has identical REST/MCP outcomes, including
      mutable revocation on the next call.
- [ ] Add optional `MediaStorage` or `DeferredHookDispatcher` only when the adapter supports those features.
- [ ] For deferred hooks, document at-least-once delivery, idempotency,
      message limits, retries/DLQ, and the non-transactional write-to-enqueue gap.
- [ ] Verify the runtime package still has no platform-specific imports.

## Current non-goals

- Do not add `SessionRepository`, `OAuthVerifier`, `UserRepository`, or `StaffRepository` runtime ports. Those were pre-ADR-0014 concepts and are not part of the current adapter contract.
- Do not add API-key, personal-token, transaction, billing, or entitlement
  repositories to Core. They are consumer state behind the adapter resolver
  and guard Procedure.
- Do not generalize `DatabaseDriver` for PostgreSQL/MongoDB or add a mapping DSL. Implement semantic ports; SQLite/D1 alone reuse the canonical SQL chain.
