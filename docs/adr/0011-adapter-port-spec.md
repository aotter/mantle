# ADR-0011: Adapter port spec

**Status:** Superseded for Core storage by ADR-0019. Retained as the alpha.7
Cloudflare adapter record; `DatabaseDriver` is now an implementation detail of
the SQLite/D1 `MantleStorageAdapter`, not the portable runtime contract.

**Date:** 2026-05-04 (revised 2026-05-09, 2026-05-10, 2026-08-11, and 2026-08-13).

## Context

`@aotter/mantle-runtime` is adapter-agnostic. It owns dispatcher, entry-writer, view executor, content-ops, render pipeline, boot validation, and MCP JSON-RPC dispatch. It depends only on `@aotter/mantle-spec` and a small set of TypeScript interfaces it defines itself.

`@aotter/mantle-cloudflare` is the only adapter shipping in v0.1.0. It binds the runtime's interfaces against Cloudflare Workers' D1 and ASSETS, and supplies a Better Auth instance (per ADR-0014) for sign-in + MCP bearer validation. OAuth grant KV remains adapter-owned infrastructure and is not a runtime port.

This ADR fixes the contract so:
- Future adapter authors have a stable target.
- PR reviewers can mechanically check "does this commit add a CF-specific type to runtime?"
- The runtime can refactor freely as long as the port shapes stay stable.

The POC accumulated multiple half-decisions about this seam (POC ADR-0015 documented an aspirational `cms-astro`-internal discipline; POC ADR-0029 retired Astro and dissolved the seam; the rebuild closes it properly).

## Decision

> 0.1.2 amendment: the portable storage input is
> `PreparedMantleStorage` (`EntryRepository & EntryReader` plus
> `ViewQueryExecutor`). Hosts either use an official storage adapter with an
> already-owned client/handle or implement those semantic ports over their own
> tables. The two-port alpha.7 contract below documents the compatibility
> facade until #673 removes it.

**Two required adapter ports**, defined as TypeScript interfaces in `@aotter/mantle-runtime/src/domain/port/`. Concrete adapters provide implementations and inject them into `createCmsRuntime`.

| Port | Surface |
|---|---|
| `DatabaseDriver` | All persistent state — `entries`, `site_config`, `staff`, `users`, plus migrations. |
| `AssetServer` | Static-asset serving for the admin SPA. The runtime hands the adapter an asset path + `Request`; the adapter returns a `Response` with the right MIME and caching. |

Rendered public artifacts are not a second storage model. D1 stays canonical;
adapters render on origin misses and may use their native HTTP response cache.
The Cloudflare adapter uses version-local Workers Cache, which runs before the
Worker for eligible anonymous responses.

Optional feature ports may also live in `domain/port/`, but they are
not part of the first-run adapter contract until a feature is enabled.
For v0.1.x media hosting and deferred lifecycle dispatch:

| Optional port | Surface |
|---|---|
| `MediaStorage` | Object-storage-shaped media upload/commit/public URL/delete contract for **public** media. Cloudflare may implement with R2, but runtime must not import R2 types. |
| `DeferredHookDispatcher` | Queue-shaped dispatcher for at-least-once `after_*` lifecycle delivery. Cloudflare may implement with Workers Queues; other adapters may use a queue, job runner, or leave it unset. |

These optional ports must not force first-run provisioning to create R2
resources. Publication starters can carry external image URLs without a
media storage implementation.

`DeferredHookDispatcher.enqueue` confirms adapter acceptance only. It cannot
make an entry write and an external queue send atomic. The versioned envelope
contains a stable event id plus captured Trigger names; handlers combine them
for idempotency because retries and ambiguous producer fallback can duplicate
execution. Deferred envelopes carry persisted entry data and normalized actor
metadata, never arbitrary original request input. Adapter-specific retry,
delay, batch, DLQ, and message-size settings remain outside manifest grammar.
The operational reference is
[`docs/deferred-lifecycle-queues.md`](../deferred-lifecycle-queues.md).

Identity, session, OAuth, and role enforcement are adapter-owned per
ADR-0014. The runtime does not define `SessionRepository`,
`OAuthVerifier`, `UserRepository`, or `StaffRepository` ports. Adapters
must provide an auth surface compatible with their HTTP framework and
must pass authenticated user/staff context into runtime dispatchers.

### Public vs private media — two buckets, two ports

`MediaStorage` deliberately models **public-only** semantics:

- `getPublicUrl()` returns an unconditional public URL. Reads bypass
  the Worker entirely (`MEDIA_PUBLIC_URL_BASE` → CDN → R2).
- `MediaAsset.publicUrl` is frozen at commit time and embedded directly
  into entry data (e.g. `posts.coverUrl`). This is intentional: for
  public assets the URL is permanent, the read path is hot, and adding
  a Worker round-trip on every render would defeat the cost / latency
  model.
- The CORS config on the underlying R2 bucket scopes browser PUTs to
  the admin origin only.

**Private content (subscription-gated, fan-club, signed-GET, etc.)
will be a *separate* port and a *separate* R2 bucket in v0.2.** Two
buckets, two ports — not one port with a `visibility` flag. Reasons:

1. **Bucket-level isolation.** Private bucket disables public access
   at the bucket level, so the worst-case "leaked private object" bug
   is structurally impossible.
2. **Different read paths.** Private reads MUST go through a Worker
   route (`/api/media/private/<key>` or similar) that runs the policy
   gate (staff predicate, subscription check, signed cookie, etc.)
   before resolving the object. The Worker either streams via
   `bucket.get()` or 302s to a short-lived signed GET URL.
3. **Different cost models.** Public bucket is CDN-cached, near-zero
   marginal cost. Private bucket charges Worker invocations on every
   read. Operator should opt into the cost knowingly, not by accident.
4. **Different MCP tool surface.** `create_private_media_upload` /
   `commit_private_media_upload` keeps the closed-list semantics of
   each tool tight. Agents pick the upload type explicitly.
5. **No migration debt.** Public assets stay public forever; their
   `coverUrl` strings remain valid. Private fields use a different
   schema field shape (`x-mcp-hint: private-media-image` over an
   opaque `assetId`, resolved at render time through the policy gate).
   No batch update over already-published entries.

Adding `PrivateMediaStorage` in v0.2 is a purely additive change to
the port set and the runtime. Current `MediaStorage` callers are
untouched. The Worker route, the use cases, the MCP tools, and the
adapter all live in their own module — they compose alongside the
public path rather than retrofitting it.

### `DatabaseDriver`

```ts
// packages/mantle-runtime/src/domain/port/DatabaseDriver.ts
export interface DatabaseDriver {
  /** Run a parameterised query. Returns a typed result-set object — adapters
   *  normalise their native driver into this shape. */
  prepare(sql: string): PreparedStatement;
  /** Multi-statement transaction. Adapters guarantee atomicity. */
  batch(stmts: ReadonlyArray<PreparedStatement>): Promise<BatchResult[]>;
  /** Migration runner — invoked by `bootInit` once per isolate. */
  migrations: MigrationRunner;
}
```

The runtime never sees `D1Database`, `Pool` (postgres), or any concrete driver. The `prepare` / `batch` shape is intentionally close to D1's surface (which is itself close to the SQLite C API) — that's the smallest common denominator. Adapters wrap their native driver to this shape.

The CF adapter's impl is a thin proxy over `env.DB` (D1). A future Postgres adapter can wrap its driver to the same shape.

### `AssetServer`

```ts
export interface AssetServer {
  /** Resolve a request to a static asset (typically under `/admin/assets/*`).
   *  Returns null if the asset doesn't exist — the adapter's HTTP layer
   *  then falls back to the SPA catchall. */
  fetch(req: Request): Promise<Response | null>;
}
```

CF adapter: wraps `env.ASSETS.fetch(req)`. Other adapters can use a filesystem or object storage.

The admin SPA itself lives in `@aotter/mantle-admin-ui` as a pre-built `dist/`. The adapter binds `AssetServer` to whatever serves that `dist/`; the runtime knows nothing about static asset serving except "ask the port and pass through the response."

## How adapters wire ports

```ts
// simplified Cloudflare adapter wiring (post-ADR-0014, amended
// 2026-05-15 by PR #193's OAuth carve-out).
import {
  createAuth,
  createCmsRef,
  createMcpApiHandler,
  createOAuthProvider,
  mountAuthorize,
  mountServerEndpoints,
  AssetsAssetServer,
  D1DatabaseDriver,
} from "@aotter/mantle-cloudflare";

const auth = createAuth({
  database: env.DB,
  baseURL: env.PUBLIC_ORIGIN,
  secret: env.BETTER_AUTH_SECRET,
  methods: [
    {
      kind: "social",
      provider: "github",
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
  ],
  bootstrapOwner: env.ADMIN_GITHUB_LOGIN
    ? { match: "github-login", value: env.ADMIN_GITHUB_LOGIN }
    : undefined,
});
const cms = createCmsRef({
  manifests,
  handlers,
  bindings: {
    db: new D1DatabaseDriver(env.DB),
    assets: new AssetsAssetServer(env.ASSETS),
  },
  auth,
});
const app = new Hono();
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
mountServerEndpoints(app, cms);
mountAuthorize(app, { auth }); // /oauth/authorize consent gate

// `OAuthProvider` must be the top-level worker entry — it injects
// `env.OAUTH_PROVIDER` helpers the consent handler needs, and the
// claude.ai MCP client requires it to discover AS metadata.
export default createOAuthProvider({
  defaultHandler: app,
  apiHandlers: {
    "/mcp/staff": createMcpApiHandler({ ref: cms, surface: "staff" }),
    "/mcp":       createMcpApiHandler({ ref: cms, surface: "public" }),
  },
});
```

The runtime gets two required adapter ports (`db`, `assets`)
alongside manifests, handlers, templates, and site defaults. Auth is
owned by the adapter layer that mounts HTTP/MCP surfaces; the runtime
receives authenticated context when the adapter dispatches requests.
There's no module-global state holding adapter-specific bindings.

## Consequences

**Hard-enforced boundaries**:
- `@aotter/mantle-runtime` MUST NOT import `D1Database`, `KVNamespace`, `Fetcher` (CF Workers ASSETS), `@cloudflare/*`, or any other adapter-specific type. CI will lint for this; PR reviewers can grep.
- A new required port can be added only by amending this ADR and updating every shipping adapter in the same change. Optional feature ports must be documented here and must state when adapters are required to implement them.
- Removing a port is also possible (if a port is found to overlap or be unnecessary), again by amending this ADR.

**Discoverability for adapter authors**:
- A future adapter author reads this ADR + [`docs/adapter-guide.md`](../adapter-guide.md), implements the two required ports, then wires boot and HTTP/MCP surfaces. That's the contract. No hidden state, no implicit assumptions about the HTTP framework.

**Test ergonomics**:
- Each port is small and isolated. Tests can mock individual ports without spinning up D1 or an OAuth provider.
- The runtime's test suite exercises against in-memory port impls; the adapter's test suite exercises the binding against real CF resources via `wrangler dev` or live deploy.

## Alternatives considered

**(a) Single mega-port** — One `RuntimePorts` interface containing every method (db.prepare, assets.fetch, media.createUpload, …). **Rejected**: leaks the entire surface onto every adapter. Discrete ports keep change blast radius per port.

**(b) Concrete CF types in runtime** — Just `import type { D1Database } from "@cloudflare/workers-types"` directly into `mantle-runtime`. Treat "CF-only" as a v0.1.0 reality, defer the abstraction. **Rejected**: this is what the POC did (via `cms-server` having implicit assumptions about D1 shape) and it's the trap the rebuild exists to escape. Once concrete CF types land in runtime, removing them is a multi-PR uplift later. Cheaper to do it right at v0.1.0.

**(c) Function-injection (no interfaces, just functions)** — Runtime accepts a record of functions such as `{ dbPrepare, assetFetch, sessionRead, … }`. **Rejected**: TypeScript interfaces are more discoverable and document grouping.

**(d) Plugin pattern (each port is a separate package)** — `@aotter/mantle-port-database`, `@aotter/mantle-port-kv`, etc., and runtime depends on one package per port. **Rejected**: the port set is too small to warrant per-port packages. Ports are TypeScript interfaces in `mantle-runtime`'s `src/domain/port/` directory — that's enough.

**(e) gRPC / wire-protocol seam** — Make ports a network protocol so adapters can be in any language. **Rejected**: the runtime is not an external service, it's a TypeScript library that adapters compose into a single Worker / Function. Network seam adds latency, deployment complexity, and operational surface for zero authoring benefit. The ports are in-process; they always will be.

## How to apply

When you're authoring `@aotter/mantle-runtime` code:

1. If you reach for a CF-specific type, **stop**. Define a method on a port instead.
2. If a port is missing the method you need, **amend this ADR first** in the same PR, then add the method. Adapters in the same PR.
3. Tests must use port mocks (in-memory implementations) — never reach into a real D1 from runtime tests.

When you're authoring an adapter:

1. Read `mantle-runtime/src/domain/port/`. Implement each required port against your runtime's primitives.
2. Compose the runtime via `createCmsRuntime({ db, assets, manifests, handlers, templates, siteDefaults, ... })`.
3. Call `runtime.bootInit()` once before serving CMS traffic.
4. Bind to your HTTP framework.
5. Provide adapter-owned auth and map sessions/scopes/roles into runtime handler context.
6. Bundle `@aotter/mantle-admin-ui`'s `dist/` via your runtime's static-asset surface and bind `AssetServer` to it.

When you're reviewing a PR:

1. Grep the diff for `@cloudflare`, `D1Database`, `KVNamespace`, `Fetcher` — flag any occurrence in `mantle-runtime/`.
2. If a new port method shows up, check it is also reflected in this ADR.
3. If a port shape changed, every shipping adapter gets updated in the same PR.

## Implementation status

- [x] Required port interface files live in `packages/mantle-runtime/src/domain/port/*.ts`.
- [x] Cloudflare required port implementations live in `packages/adapters/cloudflare/src/bindings/*.ts`.
- [x] Optional feature port `MediaStorage` (public bucket) is declared but not required by first-run adapters. `PrivateMediaStorage` is v0.2.
- [ ] CI lint: forbid `@cloudflare/*` / `D1Database` / `KVNamespace` imports in `mantle-runtime/` (post-v0.1.0; manual review until then)

## See also

- ADR-0007 — AI as primary author. Adapter port discipline serves the "AI debuggable" loop: a missing port method surfaces as a structured Diagnostic at boot, not a runtime 500 in production.
- ADR-0009 — consumer-supplied manifests. Manifests don't care about ports; ports don't care about manifests. The two abstractions compose cleanly.
