---
description: The generated src/service.ts and src/index.ts of a Mantle 0.2.0 Cloudflare service — how the surfaces are mounted, and how to add your own routes, bindings and scheduled work.
---
# The service and its entry

`mantle generate` writes two files once, then they are yours:

- `src/service.ts` composes the service: storage, identity, surfaces, and the
  `mantle` object from `createMantle`;
- `src/index.ts` is the Cloudflare entry: `fetch` and `scheduled`.

Mantle owns no route of its own. What is mounted, and where, is this code.

## `src/service.ts`

With identity `mantle` and every feature (the
[reference service](../../examples/reference-service/src/service.ts) is this
file, unchanged):

```ts
function mount(runtime: MantleRuntime, env: Env) {
  const auth = createAuth(env, origin);                       // createMantleAuth, or a setup-incomplete stub
  const resolver = createCallerResolver(auth, { jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] } });
  const authRoutes = createAuthRoutes(auth, { resolver });
  const guard = (surface, options?) => withCaller(resolver, surface, options);
  const admin = guard(createAdminSurface(runtime, { basePath: "/admin", assets: (path) => adminAsset(env.ASSETS, path), identity: { … }, site: { mcpEndpoints: { public: "/mcp", staff: "/mcp/staff" } } }));
  const mcp = guard(createMcpSurface(runtime, { basePath: "/mcp", surface: "public", resourceMetadata }), { resourceMetadata });
  // MCP Apps hosts render each staff View's rows, and the operations on one row, in the chat
  const staffMcp = guard(createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", apps: { resources: [planApp(runtime.plan, { surface: "staff", html: mantleAppHtml })] }, resourceMetadata }), { resourceMetadata });
  const rest = guard(createRestSurface(runtime, { basePath: "/api" }));
  return async (request, waitUntil) => {
    const owned = await authRoutes(request, { waitUntil });
    if (owned) return owned;
    if (under("/admin")) return admin(request);
    if (under("/mcp/staff")) return staffMcp(request);
    if (under("/mcp")) return mcp(request);
    return rest(request);
  };
}

const service: MantleService<Env> = {
  handlers,
  fetch: (request, env, { runtime, waitUntil }) => (routes ??= mount(runtime, env))(request, waitUntil),
};

export const mantle = createMantle(service, { plan, storage: (env) => d1Storage(env.DB), schedules: true });
```

- `Env` lists the bindings and vars the service reads. Add yours there.
- The surfaces are built once per isolate, on the first request.
- With identity `custom` the resolver is your `src/identity.ts`; with `none`
  every surface gets `{ kind: "anonymous" }` and no auth routes are mounted.

## Add your own routes

Put them in the function `mount` returns, where they belong in the order:

```ts
return async (request, waitUntil) => {
  const { pathname } = new URL(request.url);
  await auth.ready?.catch((error) => { routes = undefined; throw error; }); // first, before any route answers
  if (pathname === "/healthz") return new Response("ok");            // no caller
  if (pathname === "/payments/callback") return handleCallback(request, runtime, env);
  const owned = await authRoutes(request, { waitUntil });
  if (owned) return owned;
  …
};
```

- With identity `mantle`, keep `await auth.ready` above every route. `mount`
  starts Better Auth inside an isolate's first request, and Workers cancels I/O
  that a finished request started: a route that answers that first request
  before `auth.ready` settles leaves the context pending for ever, and every
  later request waits on it (under `wrangler dev` too). The wait costs only the
  isolate's first request.

- A route that acts for a caller resolves it the same way:
  `withCaller(resolver, (request, caller) => …)` gives you the caller, the 401
  for a bad credential, and the cross-origin check.
- Reach data through `runtime.store.as(caller)` or
  `runtime.invokeProcedure({ procedure, input, caller, cause: { kind: "internal", id } })`;
  `runtime.store` alone is unscoped, for trusted code only.
- Server-rendered pages, a SPA's assets, a signed webhook: all are routes
  here. Mantle renders no public pages in 0.2.0.

## `src/index.ts`

```ts
export default {
  fetch: (request, env) => mantle.fetch(request, env, ctx),
  async scheduled(controller, env) { … mantle.invokeSchedule(cron, controller.scheduledTime, env, ctx) … },
} satisfies ExportedHandler<Env>;
```

- `ctx` is `{ waitUntil }` from `cloudflare:workers`, which is not bound to one
  request, so a handler's `ctx.waitUntil` never lands on a finished request.
- Manifest crons are POSIX; Cloudflare names a cron as `wrangler.jsonc` spells
  it. The entry maps each Cloudflare cron back to every POSIX expression that
  shares it, runs them all, and reports every failure together. A cron no
  Trigger maps to throws.
- There is no `queue` handler: no Mantle path produces queue messages. Add
  your own `queue` beside `fetch` if your service uses one.

## Bindings

`wrangler.jsonc` starts with `DB` (D1), `triggers.crons`, and with feature
`admin` the console's files:

```jsonc
"assets": { "directory": "node_modules/@aotter/mantle-ui/dist/admin", "binding": "ASSETS", "run_worker_first": true, "html_handling": "none" }
```

`run_worker_first` sends every request through the Worker, so Admin answers
every `/admin` path and nothing is served at the files' bare paths; keep it
when you add assets of your own (serve those through the same binding or a
route). `mantle generate` warns when `admin` is selected and no `ASSETS` is
bound. Add the rest:

| Need | `wrangler.jsonc` | Code |
|---|---|---|
| Media | `r2_buckets: [{ binding: "MEDIA", bucket_name: … }]` | [Media uploads with R2](./media-r2.md) |
| A secret | `wrangler secret put NAME` (`.dev.vars` locally) | `env.NAME` |
| A plain var | `vars: { NAME: "…" }` | `env.NAME` |
| Email | `send_email: [{ name: "EMAIL" }]` | your `EmailSender` for sign-in, or a handler's `ctx.env.EMAIL` |
| KV, Queues, Durable Objects | their usual keys | your own code; Mantle reads none of them |

Handlers receive the same `env` as `ctx.env`. Mantle-owned rows are reached
only through Store; never write a Schema's table with `env.DB` directly. Your
own tables in the same database are yours.

## When the preset changes

The preset is never rewritten. After an SDK upgrade, compare your files with
a fresh preset: generate into an empty directory with the same manifests and
`mantle.config.json`, and diff `src/service.ts` and `src/index.ts`.
