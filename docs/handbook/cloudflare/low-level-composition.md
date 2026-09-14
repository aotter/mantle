---
description: Own the top-level Hono assembly with the same public primitives createMantleWorker uses, and the invariants you must keep.
---
# Low-level composition

Use `createMantleWorker` unless the deployment must own its top-level Worker lifecycle. This page covers when that is true, what it costs, the exported building blocks, the assembly order, and the invariants a hand-assembled Worker must preserve.

## When you need it

You need low-level composition when the Worker entry must do something the facade's single `extend` seam cannot: run logic around every response (an audit queue, custom telemetry), select bindings or Auth per request, or interleave Mantle with another framework's router. Custom handlers, routes, credential resolvers and capability bindings do not require it; see [The conventional Worker](./conventional-worker.md).

The cost is ownership. The Worker entry, error boundary, readiness handling and cache boundary become application code, and there is no automatic merge path back to `createMantleWorker`. Mantle still owns the imported adapters and standard route behavior; update them through the package version and never copy their source.

## Building blocks

All of these are exported from `@aotter/mantle/cloudflare` unless noted:

| Export | Role |
|---|---|
| `createConventionalBindings(env)` | `DB` to D1 driver, `ASSETS` to Admin assets, optional `MANTLE_KV` |
| `createConventionalAuth(env)`, `createAuth(config)` | Mode-driven Auth, or a curated custom factory |
| `conventionalMcpResource(env)`, `conventionalAuthBaseURL(env)` | `<PUBLIC_ORIGIN>/mcp` and the canonical base URL |
| `setupIncompleteAuthResponse(request, auth)` | The `503 setup_incomplete` guard for Auth-owned paths |
| `createMantleRuntimeRef(config)` | Per-isolate runtime singleton with `get()`, `web()`, `auth`, `plan` |
| `mountRuntimeEndpoints(app, ref)` | HTTP Triggers, `GET /api/views`, `GET /api/views/<name>` |
| `mountAdmin(app, ref, assets)` | Admin routes and SPA |
| `mountMantleOAuth(app, { auth, assets })` | OAuth consent and discovery, from `@aotter/mantle/admin` |
| `createMcpApiHandler({ ref, surface, resource })` | `/mcp` (`"public"`) and `/mcp/staff` (`"staff"`) handlers |
| `mountPublicRoutes(app, ref, options)` | Public HTML, `.md`, `llms.txt`, sitemap |
| `applyCachePolicy(request, response)` | The final cache decision |
| `runMantleWorkerRequest(fn)` | Redacted `500 internal_error` boundary |
| `D1DatabaseDriver`, `AssetsAssetServer`, `R2MediaStorage`, `WorkersQueueHookDispatcher`, `createQueueHandler`, `KvSiteConfigRepository`, `cloudflareTurnstileCheck`, `resolveCaller` | Individual adapters and helpers |
| `MANTLE_RESERVED_PATH_PREFIXES`, `MANTLE_RESERVED_WELL_KNOWN_PREFIX`, `MANTLE_RESERVED_EXACT_PATHS` | Core-owned path constants |

## Assembly

The order is bindings, Auth, runtime ref, Hono app, runtime endpoints, Admin, OAuth, MCP handlers, then the cache policy on every response. This example adds one application-owned audit message after each request:

```ts
import { Hono } from "hono";
import {
  applyCachePolicy,
  conventionalMcpResource,
  createMantleRuntimeRef,
  createConventionalAuth,
  createConventionalBindings,
  createMcpApiHandler,
  mountAdmin,
  mountRuntimeEndpoints,
  runMantleWorkerRequest,
  setupIncompleteAuthResponse,
  type MantleCloudflareEnv,
} from "@aotter/mantle/cloudflare";
import { mountMantleOAuth } from "@aotter/mantle/admin";
import { plan } from "../.mantle/generated/mantle.js";

interface Env extends MantleCloudflareEnv {
  readonly AUDIT_QUEUE: Queue<{ kind: "request-complete"; path: string; status: number }>;
}

let assembled: ReturnType<typeof assemble> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return runMantleWorkerRequest(async () => {
      const worker = assembled ??= assemble(env);
      if (worker.auth.ready) ctx.waitUntil(worker.auth.ready.catch((error) => {
        if (assembled === worker) assembled = undefined;   // evict a failed assembly
        throw error;
      }));
      const incomplete = await setupIncompleteAuthResponse(request, worker.auth);
      const response = incomplete ?? await worker.fetch(request, env, ctx);
      ctx.waitUntil(env.AUDIT_QUEUE.send({
        kind: "request-complete",
        path: new URL(request.url).pathname,
        status: response.status,
      }));
      return response;
    });
  },
} satisfies ExportedHandler<Env>;

function assemble(env: Env) {
  const bindings = createConventionalBindings(env);
  const auth = createConventionalAuth(env);
  const ref = createMantleRuntimeRef({ plan, bindings, auth });
  const app = new Hono<{ Bindings: Env }>();

  mountRuntimeEndpoints(app, ref);
  if (bindings.adminAssets) mountAdmin(app, ref, bindings.adminAssets);
  mountMantleOAuth(app, { auth, assets: bindings.adminAssets });
  app.get("/cache-probe", () => new Response("public", {
    headers: { "cache-control": "public, s-maxage=60" },
  }));

  const resource = conventionalMcpResource(env);
  const mcp = new Map([
    ["/mcp/staff", createMcpApiHandler<Env>({ ref, surface: "staff", resource })],
    ["/mcp", createMcpApiHandler<Env>({ ref, surface: "public", resource })],
  ]);

  return {
    auth,
    async fetch(request: Request, workerEnv: Env, ctx: ExecutionContext) {
      // Prepare the canonical D1 schema before Better Auth handles a
      // token, client, consent or CIMD request.
      await ref.get();
      const handler = mcp.get(new URL(request.url).pathname);
      const response = handler?.fetch
        ? await handler.fetch(request, workerEnv, ctx)
        : await app.fetch(request, workerEnv, ctx);
      return applyCachePolicy(request, response);
    },
  };
}
```

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "queues": { "producers": [{ "binding": "AUDIT_QUEUE", "queue": "my-site-audit" }] }
}
```

## Invariants to keep

- Await `ref.get()` before Better Auth handles a token, client, consent or CIMD request. The facade does this for Auth, `/oauth`, `/mcp`, `/admin/api` and `/.well-known/oauth*`; the example awaits before every request.
- Evict the memoized assembly when `auth.ready` rejects, so a transient D1 failure during boot does not poison the isolate.
- Pass every response through `applyCachePolicy`, after Admin, Auth, API, OAuth, MCP, application routes, redirects and errors. It marks private surfaces `private, no-store`, strips CDN override headers, and keeps only anonymous `200` `GET`/`HEAD` responses with explicit `public` freshness.
- Return `setupIncompleteAuthResponse` before dispatch so misconfigured Auth fails closed on Auth-owned paths only.
- Keep the conventional `DB` binding, both compatibility flags, and the optional `MANTLE_KV` binding. Low-level bindings may instead set `mcpCatalogKv: { namespace, scope }` with a stable deployment-owned scope, never one derived from a request.
- Pass `reservedHttpPathPrefixes` (the exported constants plus `auth.basePath`) to `createMantleRuntimeRef` so a manifest HTTP Trigger cannot claim a Core path.
- If you mount public routes, also pass `onPublicChange` to `createMantleRuntimeRef` and purge the `mantle-public` tag there with the Workers cache API. The facade wires this purge itself; a bare `createMantleRuntimeRef` does not.
- Do not replace Auth, MCP or cache handling with local copies.

## Adding an application queue producer

The audit queue above is the pattern: declare the binding in `Env` and `wrangler.jsonc`, send from `ctx.waitUntil` after the response is decided, and keep the message contract application-owned. Consume it in the same Worker by switching on `batch.queue`; see [Deferred hooks with Queues](./deferred-hooks-queues.md#multiplexing-application-queues). For the runtime pipeline these pieces sit on, see [Runtime and adapters](../concepts/runtime-and-adapters.md).

## Source
- [`docs/cloudflare-low-level-composition.md`](../../../docs/cloudflare-low-level-composition.md)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/adapters/cloudflare/src/mount/bootRuntimeOnce.ts`](../../../packages/adapters/cloudflare/src/mount/bootRuntimeOnce.ts)
- [`packages/adapters/cloudflare/src/mount/cmsConfig.ts`](../../../packages/adapters/cloudflare/src/mount/cmsConfig.ts)
- [`packages/adapters/cloudflare/src/oauth/cachePolicy.ts`](../../../packages/adapters/cloudflare/src/oauth/cachePolicy.ts)
- [`packages/adapters/cloudflare/src/index.ts`](../../../packages/adapters/cloudflare/src/index.ts)
- [`packages/adapters/cloudflare/src/bindings/index.ts`](../../../packages/adapters/cloudflare/src/bindings/index.ts)
- [`packages/adapters/cloudflare/src/mount/index.ts`](../../../packages/adapters/cloudflare/src/mount/index.ts)
- [`packages/adapters/cloudflare/src/worker/index.ts`](../../../packages/adapters/cloudflare/src/worker/index.ts)
