---
description: What Mantle 0.2.0 is, how a service is put together, and where to read next.
---
# Mantle handbook

Mantle is a manifest-driven service core. A service declares four atoms in
YAML: a **Schema** stores rows, a **View** reads them, a **Procedure** writes
them, and a **Trigger** binds a Procedure to HTTP, MCP, a lifecycle event or a
schedule. Views and Procedures are SQL in PostgreSQL syntax.

`mantle generate` compiles the manifests into a sealed plan and a typed module.
The runtime serves the plan through one **Store**, which adds each caller's
scope, TTL visibility and publishing state to every statement, and an
optimistic lock where the caller passes one. Your service owns its entry, its users and its frontend; Mantle
adds tables, surfaces and typed access to them.

This handbook ships inside `@aotter/mantle` at
`node_modules/@aotter/mantle/docs/handbook/`. The installed copy matches the
installed package; prefer it over any online copy.

## How a service fits together

```
manifests/*.yaml ──mantle generate──▶ .mantle/generated/plan.json + mantle.ts
                                          │
src/service.ts   createMantle(service, { plan, storage, schedules })
  ├─ handlers    the `ref` Procedures, typed by mantle.ts
  └─ fetch       your routes, then Mantle's surfaces behind withCaller(resolver, …):
                 auth routes · Admin at /admin · MCP at /mcp · REST at /api
src/index.ts     the host entry: Cloudflare's fetch and scheduled, or Bun.serve
```

The first `mantle generate` writes `src/service.ts`, `src/index.ts`,
`src/handlers.ts`, `tsconfig.json` and, on Cloudflare, `wrangler.jsonc` once.
After that they are your files.

## Read next

| You want to | Read |
|---|---|
| Start a service | [Quickstart](./quickstart-worker.md), then [Project layout and CLI](./project-and-cli.md) |
| Learn the model | [The four atoms](../concepts/four-atoms.md), [Reads](../concepts/views.md), [Writes](../concepts/procedures-and-triggers.md), [Authorization](../concepts/authorization.md) |
| Look up a field | [Feature table](../reference/features.md), then the [Schema](../reference/schema.md), [View](../reference/view.md), [Procedure](../reference/procedure.md) and [Trigger](../reference/trigger.md) references |
| Wire sign-in, media or deploy | [Authentication](../cloudflare/authentication.md), [Media uploads with R2](../cloudflare/media-r2.md), [Deploy and operate](../cloudflare/deploy-and-operate.md) |
| Run on ChatGPT Sites | [Mantle on ChatGPT Sites](../cloudflare/chatgpt-sites.md) |
| See whole services | [Examples](../examples/hub.md) and the runnable reference service |
| Move a 0.1.x project | `docs/upgrade-0.1-to-0.2.md` in the installed package |

The decisions behind 0.2.0 are ADR-0032 to ADR-0038 in `docs/adr/`. The ADRs
record decisions and may describe work not built yet; the installed code is the
authority. When an ADR and this handbook disagree, follow this handbook and
check the code.

## What 0.2.0 does not have yet

- **Mantle-rendered public pages.** `createWebSurface` is not ported. Render
  pages from your own `fetch` or frontend over the REST surface.
- **A preset for any host but Cloudflare and Bun.** With `--host none`,
  `mantle generate` writes the plan and its types only, and your code calls
  `createMantle`. The Bun preset has no scheduler.
- **Site settings and media on PostgreSQL.** Only the `sqlite` dialect's
  storage takes `SiteDefaults`; see [Site defaults](../reference/site-config.md).
- **Deploying to Mantle Cloud.** See [Deploy and operate](../cloudflare/deploy-and-operate.md).
