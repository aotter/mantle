# ADR-0011: Adapter port spec

**Status:** Accepted for v0.1.0. New ADR. Replaces the architectural concerns previously tracked in POC ADR-0015 (`cms-astro` internal seam discipline).

**Date:** 2026-05-04 (revised 2026-05-09 to absorb ADR-0014; revised 2026-05-10 to remove obsolete pre-ADR-0014 port text).

## Context

`@aotter/mantle-runtime` is adapter-agnostic. It owns dispatcher, entry-writer, view executor, content-ops, render pipeline, boot validation, and MCP JSON-RPC dispatch. It depends only on `@aotter/mantle-spec` and a small set of TypeScript interfaces it defines itself.

`@aotter/mantle-cloudflare` is the only adapter shipping in v0.1.0. It binds the runtime's interfaces against Cloudflare Workers' D1, KV, ASSETS, and supplies a Better Auth instance (per ADR-0014) for sign-in + MCP bearer validation.

`@aotter/mantle-netlify` is a v0.2 stub — README only. It exists in the package layout as an engineering forcing function: with N=1 adapter, "adapter-agnostic" silently rots in PR review (a `D1Database` import slips into runtime, then a second, then five). With a second adapter visible in the workspace (even if its impl is a TODO), reviewers have somewhere to point when blocking the slip.

This ADR fixes the contract so:
- Future adapter authors have a stable target.
- PR reviewers can mechanically check "does this commit add a CF-specific type to runtime?"
- The runtime can refactor freely as long as the port shapes stay stable.

The POC accumulated multiple half-decisions about this seam (POC ADR-0015 documented an aspirational `cms-astro`-internal discipline; POC ADR-0029 retired Astro and dissolved the seam; the rebuild closes it properly).

## Decision

**Three required adapter ports**, defined as TypeScript interfaces in `@aotter/mantle-runtime/src/domain/port/`. Concrete adapters provide implementations and inject them into `createCmsRuntime`.

| Port | Surface |
|---|---|
| `DatabaseDriver` | All persistent state — `entries`, `site_config`, `staff`, `users`, `approvals`, plus migrations. |
| `KvCache` | Publish-pipeline cache — pre-rendered HTML, `.md` mirrors, `llms.txt` per locale. Read-mostly, written by the publish pipeline. |
| `AssetServer` | Static-asset serving for the admin SPA. The runtime hands the adapter an asset path + `Request`; the adapter returns a `Response` with the right MIME and caching. |

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

The CF adapter's impl is a thin proxy over `env.DB` (D1). A future Postgres-via-Hyperdrive adapter wraps `pg` to the same shape; a Netlify adapter could wrap Neon, Supabase, or PlanetScale.

### `KvCache`

```ts
export interface KvCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** List keys with a prefix — used by sitemap / llms.txt aggregation. */
  list(prefix: string, cursor?: string | null): Promise<{ keys: string[]; cursor: string | null }>;
}
```

CF adapter: Workers KV. Future: Redis, FS, S3-compatible store.

### `AssetServer`

```ts
export interface AssetServer {
  /** Resolve a request to a static asset (typically under `/admin/assets/*`).
   *  Returns null if the asset doesn't exist — the adapter's HTTP layer
   *  then falls back to the SPA catchall. */
  fetch(req: Request): Promise<Response | null>;
}
```

CF adapter: wraps `env.ASSETS.fetch(req)`. Future: filesystem read, S3+CDN, Netlify static-publish dir.

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
  KvCacheBinding,
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
    kv: new KvCacheBinding(env.KV),
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

The runtime gets three required adapter ports (`db`, `kv`, `assets`)
alongside manifests, handlers, templates, and site defaults. Auth is
owned by the adapter layer that mounts HTTP/MCP surfaces; the runtime
receives authenticated context when the adapter dispatches requests.
There's no module-global state holding adapter-specific bindings.

## Consequences

**Hard-enforced boundaries**:
- `@aotter/mantle-runtime` MUST NOT import `D1Database`, `KVNamespace`, `Fetcher` (CF Workers ASSETS), `@cloudflare/*`, or any other adapter-specific type. CI will lint for this; PR reviewers can grep.
- A new required port can be added only by amending this ADR and updating ALL adapters (CF + Netlify stub) in the same change. Optional feature ports must be documented here and must state when adapters are required to implement them.
- Removing a port is also possible (if a port is found to overlap or be unnecessary), again by amending this ADR.

**Discoverability for adapter authors**:
- A future Bun/Deno/Vercel/Netlify port author reads this ADR + [`docs/adapter-guide.md`](../adapter-guide.md), implements the three required ports, then wires boot and HTTP/MCP surfaces. That's the contract. No hidden state, no implicit assumptions about the HTTP framework.

**Test ergonomics**:
- Each port is small and isolated. Tests can mock individual ports without spinning up D1 / KV / OAuth provider.
- The runtime's test suite exercises against in-memory port impls; the adapter's test suite exercises the binding against real CF resources via `wrangler dev` or live deploy.

**The Netlify stub's job**:
- The `@aotter/mantle-netlify` package's README declares a public commitment to an N>=2 adapter world. If a PR adds CF-specific code to runtime, reviewers point at the stub README and reject. The stub doesn't have to ship code to perform its function — its existence is the constraint.

## Alternatives considered

**(a) Single mega-port** — One `RuntimePorts` interface containing every method (db.prepare, kv.get, assets.fetch, media.createUpload, …). **Rejected**: leaks the entire surface onto every adapter. Adapter authors who only want to swap KV would have to touch the mega-port impl. Discrete ports keep change blast radius per port.

**(b) Concrete CF types in runtime** — Just `import type { D1Database } from "@cloudflare/workers-types"` directly into `mantle-runtime`. Treat "CF-only" as a v0.1.0 reality, defer the abstraction. **Rejected**: this is what the POC did (via `cms-server` having implicit assumptions about D1 shape) and it's the trap the rebuild exists to escape. Once concrete CF types land in runtime, removing them is a multi-PR uplift later. Cheaper to do it right at v0.1.0.

**(c) Function-injection (no interfaces, just functions)** — Runtime accepts a record of functions: `{ dbPrepare, kvGet, kvPut, sessionRead, … }`. **Rejected**: TypeScript interfaces are more discoverable (an adapter author IDE-jumps from `DatabaseDriver` to its surface; jumping from `dbPrepare` is harder). Interfaces also document grouping; functions don't.

**(d) Plugin pattern (each port is a separate package)** — `@aotter/mantle-port-database`, `@aotter/mantle-port-kv`, etc., and runtime depends on one package per port. **Rejected**: the port set is too small to warrant per-port packages. The current 5-package structure (spec / runtime / admin-ui / cloudflare / netlify) is already at the boundary of "too many"; splitting further increases the maintenance tax without useful benefit. Ports are TS interfaces in `mantle-runtime`'s `src/domain/port/` directory — that's enough.

**(e) gRPC / wire-protocol seam** — Make ports a network protocol so adapters can be in any language. **Rejected**: the runtime is not an external service, it's a TypeScript library that adapters compose into a single Worker / Function. Network seam adds latency, deployment complexity, and operational surface for zero authoring benefit. The ports are in-process; they always will be.

## How to apply

When you're authoring `@aotter/mantle-runtime` code:

1. If you reach for a CF-specific type, **stop**. Define a method on a port instead.
2. If a port is missing the method you need, **amend this ADR first** in the same PR, then add the method. Adapters in the same PR.
3. Tests must use port mocks (in-memory implementations) — never reach into a real D1 / KV from runtime tests.

When you're authoring an adapter (`@aotter/mantle-cloudflare` for v0.1.0; future `mantle-netlify`, `mantle-bun`, …):

1. Read `mantle-runtime/src/domain/port/`. Implement each required port against your runtime's primitives.
2. Compose the runtime via `createCmsRuntime({ db, kv, assets, manifests, handlers, templates, siteDefaults, ... })`.
3. Call `runtime.bootInit()` once before serving CMS traffic.
4. Bind to your HTTP framework — Hono on CF, Netlify Functions handler, raw `fetch` Worker, …
5. Provide adapter-owned auth and map sessions/scopes/roles into runtime handler context.
6. Bundle `@aotter/mantle-admin-ui`'s `dist/` via your runtime's static-asset surface and bind `AssetServer` to it.

When you're reviewing a PR:

1. Grep the diff for `@cloudflare`, `D1Database`, `KVNamespace`, `Fetcher` — flag any occurrence in `mantle-runtime/`.
2. If a new port method shows up, check it's also reflected in this ADR + the Netlify stub README.
3. If a port shape changed, all 2 adapters (CF real, Netlify stub) get updated in the same PR.

## Implementation status

- [x] Required port interface files live in `packages/mantle-runtime/src/domain/port/*.ts`.
- [x] Cloudflare required port implementations live in `packages/adapters/cloudflare/src/bindings/*.ts`.
- [x] Optional feature port `MediaStorage` (public bucket) is declared but not required by first-run adapters. `PrivateMediaStorage` is v0.2.
- [x] Netlify stub README references this ADR.
- [ ] CI lint: forbid `@cloudflare/*` / `D1Database` / `KVNamespace` imports in `mantle-runtime/` (post-v0.1.0; manual review until then)

## See also

- ADR-0007 — AI as primary author. Adapter port discipline serves the "AI debuggable" loop: a missing port method surfaces as a structured Diagnostic at boot, not a runtime 500 in production.
- ADR-0009 — consumer-supplied manifests. Manifests don't care about ports; ports don't care about manifests. The two abstractions compose cleanly.
