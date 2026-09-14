---
description: Each Cloudflare primitive a Mantle Worker can bind, what Mantle uses it for, the wrangler snippet, and the Env type.
---
# Bindings and primitives

This page lists every Cloudflare binding a Mantle Worker commonly declares: which are required, what Mantle does with each, the `wrangler.jsonc` snippet, and the matching `Env` field. Read it when you write or review a Worker's configuration.

## Compatibility flags

Every Mantle Worker keeps both flags:

```jsonc
"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]
```

`nodejs_compat` is required by the adapter and its Auth dependencies. `global_fetch_strictly_public` is required because MCP client metadata (CIMD) is fetched through the public Internet boundary.

## The composition-root rule

Bindings appear in two places only: the Worker entry (`createMantleWorker` options and the `bindings` hook) and `wrangler.jsonc`. Procedure handlers receive them through `ctx.env`. An application may own additional tables behind its own repository, but it never queries Mantle-owned tables (`entries`, site settings, media, Auth) outside the runtime. Use `runtime.entries`, generated `bindMantle(runtime)` and Views instead.

## The Env interface

```ts
import type { DeferredHookEnvelope } from "@aotter/mantle/runtime";
import type { MantleCloudflareEnv } from "@aotter/mantle/cloudflare";

interface EmailBinding {
  send(message: { to: string; from: string; subject: string; text?: string; replyTo?: string }): Promise<unknown>;
}

export interface Env extends MantleCloudflareEnv {
  // MantleCloudflareEnv already declares DB, ASSETS?, MANTLE_KV? and the auth vars.
  readonly DB: D1Database;                                   // required
  readonly ASSETS: Fetcher;                                  // Admin bundle + your frontend
  readonly PUBLIC_ORIGIN: string;
  readonly MANTLE_KV?: KVNamespace;                          // optional MCP catalog cache
  readonly MEDIA_BUCKET?: R2Bucket;                          // optional media
  readonly R2_ACCOUNT_ID?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
  readonly MEDIA_PUBLIC_URL_BASE?: string;
  readonly MANTLE_INTERNAL_QUEUE?: Queue<DeferredHookEnvelope>;  // optional deferred hooks
  readonly ORDER_EXPIRY_QUEUE?: Queue<{ type: "expire-order"; orderToken: string }>;  // application queue
  readonly INVENTORY_COORDINATOR?: DurableObjectNamespace;  // application-owned
  readonly EMAIL?: EmailBinding;                             // Email Service
  readonly TURNSTILE_SECRET_KEY?: string;                    // secret
}
```

## D1: `DB` (required)

D1 is canonical storage. It holds `entries` (JSON data plus generated index columns), site settings, media metadata and pending uploads, and the Better Auth tables. `createConventionalBindings` throws without `DB`.

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "my-site", "database_id": "<production-id>" }
]
```

Omit `database_id` only for local development. Set the production id before any remote deploy.

## Static Assets: `ASSETS`

```jsonc
"assets": { "directory": "./public", "binding": "ASSETS" }
```

`mantle generate` syncs the Admin SPA into `public/_mantle/admin/` when `@aotter/mantle-admin-ui` is installed. The facade wraps `ASSETS` as the Admin asset server and falls back to `/_mantle/admin/index.html` for client-side Admin routes. The same binding serves your own CSS, JS and icons.

When Worker routes and static paths overlap, list Worker-owned paths in `run_worker_first` and keep `not_found_handling` at `"none"` so unmatched requests fall through to the Worker. A production configuration lists `/admin`, `/admin/*`, `/mcp`, `/mcp/*`, `/oauth`, `/oauth/*`, `/.well-known/*`, `/api/*`, `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/*/llms.txt` and every public content prefix there, so a static file can never shadow a Mantle route.

## Workers Cache

```jsonc
"cache": { "enabled": true }
```

Mantle stores nothing in the cache itself. It marks anonymous `200` `GET`/`HEAD` responses from the public mount (HTML, `.md`, `llms.txt`, sitemap) with `public, max-age=0, s-maxage=300` and `Cache-Tag: mantle-public`; everything else is `private, no-store`. Publishing-content and site-setting writes purge the tag. The local emulator does not simulate the entrypoint cache or its purge API. See [Public web](./public-web.md#cache-contract).

## KV: `MANTLE_KV` (optional)

```jsonc
"kv_namespaces": [
  { "binding": "MANTLE_KV", "id": "<production-id>", "preview_id": "<development-id>" }
]
```

A deployment-owned namespace that caches the caller-independent MCP catalog projection (brand, description, origin, icons, media-purpose policy) so an authenticated MCP catalog does not read D1 site settings. D1 stays canonical; missing or expired snapshots are repaired from D1 within one hour, and a KV failure never fails a committed write. Never store tokens, sessions or content here. `createConventionalBindings` detects it automatically.

## R2: `MEDIA_BUCKET` (optional)

```jsonc
"r2_buckets": [{ "binding": "MEDIA_BUCKET", "bucket_name": "<project>-media" }]
```

Staff media uploads through Staff MCP presigned PUT. The binding alone cannot sign URLs; you also need `R2_ACCOUNT_ID`, `MEDIA_PUBLIC_URL_BASE` and the two S3 credential secrets. See [Media uploads with R2](./media-r2.md).

## Queues

```jsonc
"queues": {
  "producers": [
    { "binding": "MANTLE_INTERNAL_QUEUE", "queue": "mantle-internal" },
    { "binding": "ORDER_EXPIRY_QUEUE", "queue": "my-site-order-expiry" }
  ],
  "consumers": [
    { "queue": "mantle-internal", "max_batch_size": 10, "max_batch_timeout": 5,
      "max_retries": 5, "retry_delay": 60, "dead_letter_queue": "mantle-internal-dlq" },
    { "queue": "my-site-order-expiry", "max_concurrency": 1, "max_batch_size": 10,
      "max_retries": 5, "retry_delay": 30, "dead_letter_queue": "my-site-order-expiry-dlq" }
  ]
}
```

`MANTLE_INTERNAL_QUEUE` carries deferred `after_*` lifecycle hooks. Application queues share the same Worker; the `queue()` export switches on `batch.queue`. See [Deferred hooks with Queues](./deferred-hooks-queues.md).

## Cron Triggers

```jsonc
"triggers": { "crons": ["*/5 * * * *"] }
```

A `scheduled()` handler reuses the fetch path's runtime and invokes a Procedure that has no Trigger of its own:

```ts
import { bindMantle } from "../.mantle/generated/mantle.js";

const worker = createMantleWorker<Env>({ plan, handlers });

export default {
  fetch: worker.fetch,
  async scheduled(_controller, env, ctx) {
    const mantle = bindMantle(await worker.getRuntime(env));
    const result = await mantle.procedures.sweepExpiredOrders(
      { now: Date.now() },
      { user: null, staff: null, env, waitUntil: (p) => ctx.waitUntil(p) },
    );
    if (!result.ok) throw new Error(`sweep failed: ${result.diagnostic.code}`);
  },
} satisfies ExportedHandler<Env>;
```

## Durable Objects (application-owned)

Durable Objects are not a Core primitive. Use one as an application-owned coordinator when a decision must be serialized, for example reserving inventory exactly once. Export the class from the Worker entry, then bind and migrate it:

```jsonc
"durable_objects": { "bindings": [{ "name": "INVENTORY_COORDINATOR", "class_name": "InventoryCoordinator" }] },
"migrations": [{ "tag": "inventory-v1", "new_sqlite_classes": ["InventoryCoordinator"] }]
```

```ts
export { InventoryCoordinator } from "./commerce/InventoryCoordinator.js";
```

The coordinator keeps its own state; Mantle entries mirror the result. See [Commerce transaction](../examples/commerce-transaction.md).

## Email Service: `[[send_email]]`

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

Send from an `after_create` handler with `errorPolicy: continue`, and fail soft when the binding or addresses are absent so submissions still save on a fresh deployment:

```ts
export async function notifyIntake(input: { name?: string; email?: string }, ctx: HandlerContext) {
  const env = ctx.env as Env & { INTAKE_NOTIFY_TO?: string; INTAKE_NOTIFY_FROM?: string };
  if (!env.EMAIL || !env.INTAKE_NOTIFY_TO || !env.INTAKE_NOTIFY_FROM) {
    console.info("[intake] notification not configured");
    return { ok: true };
  }
  await env.EMAIL.send({
    to: env.INTAKE_NOTIFY_TO,
    from: env.INTAKE_NOTIFY_FROM,
    subject: `New intake response from ${input.name ?? "website"}`,
    text: `Email: ${input.email ?? ""}`,
    ...(input.email ? { replyTo: input.email } : {}),
  });
  return { ok: true };
}
```

## Turnstile

Store the secret with `wrangler secret put TURNSTILE_SECRET_KEY`. Declare the token in the Procedure input, then verify it in a `before_create` lifecycle Trigger that aborts on failure:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: intake-before-create-verify-turnstile
spec:
  source:
    kind: lifecycle
    schema: intake-submissions
    on: [before_create]
    errorPolicy: abort
  target:
    procedure: verify-intake-turnstile
```

The adapter exports a handler factory for the `siteverify` call:

```ts
import { cloudflareTurnstileCheck } from "@aotter/mantle/cloudflare";

extend: ({ env }) => ({
  handlers: {
    "verify-intake-turnstile": cloudflareTurnstileCheck({
      secret: env.TURNSTILE_SECRET_KEY ?? "dev-stub",
      tokenField: "turnstileToken",
    }),
  },
}),
```

Authenticated callers (`ctx.user` set) bypass the check. The literal secret `"dev-stub"` skips the network and rejects only the token `"fail"`. Rejection throws `AUTH_DENIED`, which maps to HTTP `403`. See [Intake form](../examples/intake-form.md).

## Source
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`packages/adapters/cloudflare/src/bindings/conventionalBindings.ts`](../../../packages/adapters/cloudflare/src/bindings/conventionalBindings.ts)
- [`packages/adapters/cloudflare/src/mount/cmsConfig.ts`](../../../packages/adapters/cloudflare/src/mount/cmsConfig.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/adapters/cloudflare/src/handlers/turnstile.ts`](../../../packages/adapters/cloudflare/src/handlers/turnstile.ts)
- [`packages/mantle/src/cli/generate.ts`](../../../packages/mantle/src/cli/generate.ts)
- [`docs/deferred-lifecycle-queues.md`](../../../docs/deferred-lifecycle-queues.md)
- [`docs/media-uploads.md`](../../../docs/media-uploads.md)
- [`docs/performance-harness.md`](../../../docs/performance-harness.md)
- [`docs/cloudflare-low-level-composition.md`](../../../docs/cloudflare-low-level-composition.md)
- [`docs/examples/minimal-worker/wrangler.jsonc`](../../../docs/examples/minimal-worker/wrangler.jsonc)
- Retired-starter patterns: [`blank/wrangler.toml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/blank/wrangler.toml), [`overlays/transaction/wrangler.append.toml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/wrangler.append.toml), [`overlays/transaction/src/index.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/src/index.ts), [`overlays/transaction/src/mantle/config.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/src/mantle/config.ts), [`overlays/intake/src/worker/features/intake/notifyIntake.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/intake/src/worker/features/intake/notifyIntake.ts), [`overlays/intake/manifests/site.yaml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/intake/manifests/site.yaml)
