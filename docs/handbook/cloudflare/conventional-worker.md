---
description: Assemble a Mantle Worker with createMantleWorker, add handlers and routes through extend, and respect Core-owned paths.
---
# The conventional Worker

New applications can start with `mantle generate --host cf`, which writes a
blank home, Worker entry and selected Admin/API/MCP wiring. This page covers
the lower-level `createMantleWorker` facade for applications that author their
own Worker entry: its options, extension seam, readiness and reserved paths.

## Minimal entry

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan, cacheScope: "my-site-production" });
```

`plan` is the sealed plan that `mantle generate` writes to `.mantle/generated/mantle.ts`. With only `plan`, this manually assembled Worker serves public View REST, HTTP Triggers, Admin, Auth, OAuth and MCP. It renders no public pages and `/` is a 404; see [Public web](./public-web.md). A newly generated full CF project wires a separate editable blank home. Local Admin with email OTP replaces Auth construction; see [Quickstart: local Admin](../start/quickstart-admin.md). Admin still requires the `ASSETS` binding.

## Options

| Option | Type | Purpose |
|---|---|---|
| `plan` | `RuntimePlan` | Required. Generated plan; a fingerprint or version mismatch fails immediately and asks you to regenerate. |
| `handlers` | `Record<string, AnyHandler>` | Implementations for `handler.kind: ref` Procedures. Merged with `extend().handlers`; a name registered twice throws. |
| `siteDefaults` | `SiteDefaults \| (env) => SiteDefaults` | Brand, title, description, origin, locales, icons, media purposes. Use the function form to read `env.PUBLIC_ORIGIN`. See [Site config](../reference/site-config.md). |
| `cacheScope` | `string \| (env) => string` | Stable deployment/site identifier for public cache tags and optional `MANTLE_KV` keys. Lowercase letters, digits, `_` and `-`, up to 64 characters. Shared caching is disabled when absent or invalid. |
| `templates` | `TemplateRegistry` | Entry and list templates for public HTML. |
| `publicPathResolver` | `PublicPathResolver` | Collection-to-URL mapping used for canonical URLs, sitemap and hreflang. |
| `mediaAllowSvg` | `boolean \| (env) => boolean` | Accept SVG uploads. Default `false`. |
| `auth` | `(env) => Auth` | Replace Auth construction only. Core still owns the Auth routes. |
| `bindings` | `(env, conventional) => MantleWorkerBindings` | Augment the conventional adapters, for example `mediaStorage` or `deferredHookDispatcher`. |
| `extend` | `(ctx) => MantleWorkerExtension \| void` | The one seam for handlers, credential resolution, JWT bearer verification and new Hono routes. |

`extend` receives `{ env, auth, bindings, getRuntime }` and may return:

```ts
{
  handlers?: Record<string, AnyHandler>;
  credentialResolver?: ConsumerCredentialResolver;   // site-owned API keys and personal tokens
  jwtBearer?: { audience: string; scopes?: readonly string[] };
  mount?: ({ app, ref, env, auth, bindings, getRuntime }) => void;
}
```

`extend` may run again after a failed initialization. Keep external side effects out of it.

## What the facade owns

Once per isolate, `createMantleWorker` assembles and memoizes:

- Conventional bindings: `DB` becomes the D1 driver, `ASSETS` serves the Admin bundle, `MANTLE_KV` (when bound) becomes the MCP catalog projection. See [Bindings](./bindings.md).
- Conventional Auth chosen by `MANTLE_AUTH_MODE`, or your `auth` factory. See [Authentication](./authentication.md).
- Runtime endpoints: manifest HTTP Triggers, `GET /api/views` and `GET /api/views/<name>` for public Views.
- Admin at `/admin` when Admin assets are present, OAuth consent and discovery, and MCP at `/mcp` and `/mcp/staff`. The MCP transport is Streamable HTTP, POST-only: no session header, no server-initiated stream (`GET` answers `405`), and `tools/call` answers `401` with an OAuth challenge so a client can authenticate mid-session and retry. Verified against the official TypeScript client SDK `@modelcontextprotocol/client` 2.0.0 in the adapter's conformance test; that pin is the gate when the SDK is upgraded.
- A `/favicon.ico` route derived from `siteDefaults.icons`. This is a convention, not a reserved path; an existing host route wins.
- The final cache policy on every response, and best-effort purge of the deployment-scoped public tag after publishing-content and site-setting writes.
- A redacted error boundary: an unexpected failure returns `500` with `{ "ok": false, "error": "internal_error" }` and `private, no-store`.

If `auth.ready` rejects, the memoized assembly is evicted so the next request rebuilds instead of reusing a poisoned isolate.

## The returned handler

```ts
const worker = createMantleWorker<Env>({ plan });
worker.fetch(request, env, ctx);   // HTTP entry
worker.getRuntime(env);            // the runtime fetch uses, resolved after auth.ready
worker.scheduled(controller, env, ctx); // declared scheduled Procedure Triggers
```

Queue handlers call `worker.getRuntime(env)` and then generated `bindMantle(runtime)` so they reuse the assembled runtime. Scheduled Procedure Triggers use `worker.scheduled` with expressions registered in Wrangler. See [Bindings](./bindings.md#cron-triggers), [Trigger](../reference/trigger.md#schedule-source), and [Deferred hooks](./deferred-hooks-queues.md).

## Readiness rule

Standard protected routes establish readiness themselves: the facade awaits `getRuntime()` before Auth, `/oauth`, `/mcp`, `/admin/api` and `/.well-known/oauth*` requests. Extension routes do not. Before an extension route reads or writes Mantle data, or relies on database-backed Auth, it must `await ref.get()` (inside `mount`) or `await getRuntime()`.

`getRuntime` rejects when called synchronously inside `extend` before it returns. Retain the function and call it later, for example inside a request handler.

## Reserved paths

Extensions add routes; they never replace Core surfaces. These registrations are rejected:

- `/admin`, `/_mantle`, `/api/auth`, `/api/views`, `/oauth`, `/mcp`, and anything beneath them
- `/.well-known/oauth*`
- the custom Auth factory's `basePath`
- global `*` and `/*` handlers
- any exact method and path pair that a manifest HTTP Trigger already owns

Static literals fail TypeScript during your build (`MantleExtensionPath`). Computed paths cannot be proven statically, so after `mount` returns the facade inspects Hono's assembled route table and throws before serving any request. There is no override option. The `app` passed to `mount` exposes `get`, `post`, `put`, `patch`, `delete`, `options`, `all`, `on`, `use` and `route`; it omits global error and not-found hooks.

## Handlers and routes

```ts
import { createMantleWorker, type MantleCloudflareEnv } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";
import { notifyIntake } from "./handlers/notifyIntake.js";

interface Env extends MantleCloudflareEnv {
  readonly PUBLIC_ORIGIN: string;
}

export default createMantleWorker<Env>({
  plan,
  siteDefaults: (env) => ({
    brand: "Example",
    title: "Example",
    description: "Example site.",
    origin: env.PUBLIC_ORIGIN,
    locales: ["en"],
    icons: [
      { src: "/site-icon.png", mimeType: "image/png", sizes: ["64x64"] },
      { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  }),
  extend: () => ({
    handlers: { "notify-intake": notifyIntake },
    mount({ app, ref }) {
      app.get("/api/health", (c) => c.json({ ok: true }));
      app.get("/api/locales", async (c) => {
        const runtime = await ref.get();            // readiness before data
        const site = await runtime.siteConfig.load();
        return c.json({ locales: site.locales });
      });
    },
  }),
});
```

Handler keys match `spec.handler.ref` in Procedure manifests; see [Procedures and Triggers](../concepts/procedures-and-triggers.md).

## A `bindings` hook

`bindings` receives the conventional set and returns the set the runtime uses. Spread the conventional bindings, then add capability adapters:

```ts
import {
  createMantleWorker,
  WorkersQueueHookDispatcher,
} from "@aotter/mantle/cloudflare";

export default createMantleWorker<Env>({
  plan,
  bindings: (env, conventional) => ({
    ...conventional,
    mediaStorage: buildMediaStorage(env),          // see media-r2.md
    deferredHookDispatcher: new WorkersQueueHookDispatcher(env.MANTLE_INTERNAL_QUEUE),
  }),
});
```

The conventional set is `{ db, adminAssets, mcpCatalogKv? }`. Never drop `db`.

## Site identity

`siteDefaults.icons` is one identity reused by browser favicons, Admin chrome and MCP `serverInfo.icons`. Keep the SVG as the editable source and add a PNG rendition for MCP clients that need raster formats. Both files live in `public/`.

## Source
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/adapters/cloudflare/src/bindings/conventionalBindings.ts`](../../../packages/adapters/cloudflare/src/bindings/conventionalBindings.ts)
- [`packages/adapters/cloudflare/src/mount/cmsConfig.ts`](../../../packages/adapters/cloudflare/src/mount/cmsConfig.ts)
- [`docs/examples/host-local-admin-otp/src/index.ts`](../../../docs/examples/host-local-admin-otp/src/index.ts)
- [`docs/examples/host-minimal-worker/src/index.ts`](../../../docs/examples/host-minimal-worker/src/index.ts)
