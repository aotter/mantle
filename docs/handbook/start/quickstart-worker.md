---
description: "Author a minimal Cloudflare Worker from scratch: one Schema, one public View, generate, validate, run locally and probe it with curl."
---
# Quickstart: a minimal Worker

This page reproduces Core's API-only Worker reference as a from-scratch walkthrough. It is the embed / adapter path: View REST without Admin, Auth or a visitor frontend. Admin is opt-in when humans need a console — [Quickstart: local Admin](./quickstart-admin.md). Install every `@aotter/mantle*` package from the `latest` dist-tag; see [Versions](../reference/surface.md#versions).

## Prerequisites

- Node.js 22 or newer.
- pnpm 9 or newer. The reference is tested with pnpm; see the npm note at the end of this page.
- `wrangler` is installed as a project devDependency below. No Cloudflare account, D1 database or secret is needed for the local loop.

## 1. `package.json`

Install every `@aotter/mantle*` package from the `latest` dist-tag and add the peers the Cloudflare adapter needs.

```json
{
  "name": "mantle-minimal-consumer",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "mantle generate",
    "validate": "mantle validate",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev --local --ip 127.0.0.1 --port 8787",
    "check": "mantle generate && mantle generate --check && mantle validate && mantle skills && mantle skills --check && tsc --noEmit"
  },
  "dependencies": {
    "@aotter/mantle": "latest",
    "@aotter/mantle-cloudflare": "latest",
    "better-auth": "1.7.2",
    "hono": "^4.13.3",
    "zod": "^4.5.4",
    "aws4fetch": "^1.0.20"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260907.1",
    "typescript": "^6.0.3",
    "wrangler": "^4.125.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

The reference's own `check` script ends with `&& node smoke.mjs`, a test that starts the Worker and asserts the three probes in step 6. This walkthrough runs those probes by hand instead.

Add a `tsconfig.json` that includes the generated module:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts", ".mantle/generated/**/*.ts"]
}
```

## 2. `manifests/site.yaml`

One publishing Schema and one public View. `mantle generate` never invents a Schema; this notes model is example business data.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: notes
spec:
  title: Notes
  schema:
    type: object
    required: [title]
    properties:
      title: { type: string }
  lifecycle: publishing
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: published-notes
spec:
  surface: public
  from: notes
  cache: { sharedMaxAge: 3600 }
  fields: [id, title]
  filter:
    eq: { field: status, value: published }
  limit: 20
```

## 3. `src/index.ts`

The conventional Worker entry hands the sealed plan to the Cloudflare adapter.

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

`createMantleWorker` owns the D1 and assets bindings, Auth, Admin, View REST, HTTP Triggers, OAuth, MCP and cache policy. Application handlers and extra routes go through its `extend` option; see [the conventional Worker](../cloudflare/conventional-worker.md).

## 4. `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mantle-reference",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-08",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "observability": { "enabled": true },
  "vars": { "MANTLE_AUTH_MODE": "self-managed" },
  "d1_databases": [
    { "binding": "DB", "database_name": "mantle-reference-local" }
  ]
}
```

Both compatibility flags are required by the adapter. `MANTLE_AUTH_MODE` must be explicit; `self-managed` without GitHub credentials is a deliberate partial configuration for this local reference, so Auth-owned routes fail closed while public routes work. Local `wrangler dev` creates the D1 database on demand; configure a real `database_id` and the full auth matrix before any remote deploy ([Authentication](../cloudflare/authentication.md)).

## 5. Install, generate, validate, run

```sh
pnpm install
pnpm exec mantle generate
pnpm exec mantle validate
pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8787
```

`mantle validate` prints `OK  no issues (root: manifests, phase: preview)`. Wrangler prints `Ready on http://127.0.0.1:8787`. Use that origin in the next step. The Admin OTP path uses the same pin; `PUBLIC_ORIGIN` must match wrangler's printed origin there.

## 6. Probe the Worker

```sh
curl -s http://127.0.0.1:8787/api/views/published-notes
```

```json
{ "ok": true, "data": { "rows": [], "page": 1, "show": 20, "hasMore": false } }
```

The View is served with no data because the local D1 is fresh. `show` follows the View's `limit` when the request carries no `?show=`; `?page=` and `?show=` are the reserved pagination params ([Reads: Views, REST and MCP](../concepts/views.md)).

```sh
curl -i http://127.0.0.1:8787/
```

`GET /` returns `404`. No visitor frontend is installed or rendered; `mantle-web` is optional composition and never owns an implicit home route. Add your own routes or templates when the product needs them ([Public web, SEO and cache](../cloudflare/public-web.md)).

```sh
curl -i http://127.0.0.1:8787/mcp/staff
```

`GET /mcp/staff` returns `503` with the error code `setup_incomplete` until `MANTLE_AUTH_MODE` is backed by a complete configuration. This is the expected fail-closed state; a working public endpoint is not evidence of a working Admin or MCP login.

## What `mantle generate` wrote

- `.mantle/generated/mantle.ts` — one module with the sealed `plan`, generated types (`MantleHandlers<Env>`), `createMantle` and `bindMantle`. The Worker entry above imports only `plan`.
- `public/_mantle/admin/` — the Admin SPA, synced only when `@aotter/mantle-admin-ui` is installed. This project did not install it, so nothing is written there and `/admin` has no assets.

`generate` fails on missing or invalid manifests and never creates a project, a default Schema or a home route. `mantle generate --check` reports stale output without writing. The reference keeps `.mantle/`, `.agents/` and `.claude/` out of git and regenerates them in `check`; see [Project layout and the CLI loop](./project-and-cli.md).

> **npm and optional peers**
> A cold npm install can fail with `ERESOLVE` when an Auth peer selects a different optional `@libsql/client` than this snapshot declares. If that happens, pin `@libsql/client` in `overrides` to the range in this checkout's `package.json` and rerun `npm install`. Do not use `--force`. Commit the lockfile and use `npm ci` afterwards.

## Next steps

- [Quickstart: local Admin](./quickstart-admin.md) — opt-in Dev UI: ASSETS, prebuilt Admin, email OTP.
- [Project layout and the CLI loop](./project-and-cli.md) — the files you own, every CLI flag, the daily check loop.
- [The four atoms](../concepts/four-atoms.md) — add a Procedure and a Trigger to accept writes.
- [Authentication](../cloudflare/authentication.md) — complete Auth so Admin and `/mcp/staff` open.
- [Public web, SEO and cache](../cloudflare/public-web.md) — give the service a rendered public surface.

## Source
- [`docs/examples/host-minimal-worker/README.md`](../../../docs/examples/host-minimal-worker/README.md)
- [`docs/examples/host-minimal-worker/package.json`](../../../docs/examples/host-minimal-worker/package.json)
- [`docs/examples/host-minimal-worker/tsconfig.json`](../../../docs/examples/host-minimal-worker/tsconfig.json)
- [`docs/examples/host-minimal-worker/manifests/site.yaml`](../../../docs/examples/host-minimal-worker/manifests/site.yaml)
- [`docs/examples/host-minimal-worker/src/index.ts`](../../../docs/examples/host-minimal-worker/src/index.ts)
- [`docs/examples/host-minimal-worker/wrangler.jsonc`](../../../docs/examples/host-minimal-worker/wrangler.jsonc)
- [`docs/examples/host-minimal-worker/smoke.mjs`](../../../docs/examples/host-minimal-worker/smoke.mjs)
- [`docs/direct-authoring.md`](../../../docs/direct-authoring.md)
- [`packages/mantle-runtime/src/domain/service/Pagination.ts`](../../../packages/mantle-runtime/src/domain/service/Pagination.ts)
