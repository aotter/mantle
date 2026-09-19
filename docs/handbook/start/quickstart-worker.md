---
description: "Start path for a coding agent bringing a human: interview, author a local Worker, run it on local D1, then sign into Admin with email OTP from the Wrangler log."
---
# Start: a local Worker and Admin

This is the start path for a coding agent bringing a human. Learn the grammar from this page and the handbook examples. Interview the human. Author a local Cloudflare Worker on local D1. Get it running. Then the human signs into Admin with an email OTP printed in the Worker logs.

There is no `mantle create`, no visitor homepage, and no Cloud-first step. `GET /` stays 404 until the application adds a frontend. Do not rebuild Admin; install `@aotter/mantle-admin-ui` and use the shipped SPA.

The [minimal Worker reference](../../examples/minimal-worker/README.md) is the tested API-only subset (generate, validate, curl). This page adds Admin UI and local email OTP so a human can sign in. Pin every `@aotter/mantle*` package to the exact version in this snapshot (`packages/mantle/package.json`); see [Versions](../reference/surface.md#versions).

## Interview first

Ask the human before writing files:

- What service is this, in one sentence?
- Who uses it (staff, members, anonymous callers)?
- Which records are stored? Which fields matter?
- What can people read, and what can they write?
- Which email should become the first Admin owner?

Do not invent a default notes model, a homepage, or Cloud resources. Use the answers as the content model. The YAML below is example business data so the walkthrough is concrete; replace it with the interview.

Handbook examples supply full grammar inspiration: [intake](../examples/intake-form.md), [publication](../examples/publication.md), [reservation](../examples/reservation.md), [procurement](../examples/procurement-approvals.md), [commerce](../examples/commerce-transaction.md), [guarded API](../examples/guarded-api.md).

## Prerequisites

- Node.js 22 or newer.
- pnpm 9 or newer. The reference is tested with pnpm; see the npm note at the end of this page.
- `wrangler` is installed as a project devDependency below. No Cloudflare account, remote D1 database or GitHub OAuth app is needed for the local loop.

## 1. `package.json`

Pin every `@aotter/mantle*` package to the same exact release. Include the Cloudflare adapter, Admin UI, and the peers the adapter needs.

```json
{
  "name": "my-service",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "mantle generate",
    "validate": "mantle validate",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev --local",
    "check": "mantle generate && mantle generate --check && mantle validate && mantle skills && mantle skills --check && tsc --noEmit"
  },
  "dependencies": {
    "@aotter/mantle": "0.1.2-alpha.6",
    "@aotter/mantle-admin-ui": "0.1.2-alpha.6",
    "@aotter/mantle-cloudflare": "0.1.2-alpha.6",
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

The API-only reference's `check` script ends with `&& node smoke.mjs`. This walkthrough probes by hand and then opens Admin.

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

One Schema and one public View from the interview. `mantle generate` never invents a Schema.

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
  fields: [id, title]
  filter:
    eq: { field: status, value: published }
  limit: 20
```

## 3. `src/index.ts`

The conventional Worker entry hands the sealed plan to the Cloudflare adapter. For the local human milestone, replace conventional GitHub Auth with email OTP and `ConsoleEmailSender`. That sender prints the code to the Wrangler log. Never wire it on a remote deploy.

```ts
import {
  ConsoleEmailSender,
  createAuth,
  createMantleWorker,
} from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  BETTER_AUTH_SECRET?: string;
  PUBLIC_ORIGIN?: string;
}

export default createMantleWorker<Env>({
  plan,
  cacheScope: "my-service-local",
  auth: (env) => {
    const secret = env.BETTER_AUTH_SECRET;
    if (!secret) {
      throw new Error("Set BETTER_AUTH_SECRET in .dev.vars for local Admin sign-in.");
    }
    return createAuth({
      database: env.DB,
      baseURL: env.PUBLIC_ORIGIN ?? "http://localhost:8787",
      secret,
      methods: [{ kind: "email-otp", sender: new ConsoleEmailSender() }],
      bootstrapOwner: { match: "email", value: "you@example.com" },
    });
  },
});
```

Replace `you@example.com` with the email from the interview. With `auth` set, `MANTLE_AUTH_MODE` is not read. `createMantleWorker` still owns D1, Admin, View REST, HTTP Triggers, OAuth and MCP; application handlers go through `extend`. See [the conventional Worker](../cloudflare/conventional-worker.md) and [local Admin sign-in](../cloudflare/authentication.md#local-admin-sign-in-email-otp).

## 4. `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-service",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-08",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "observability": { "enabled": true },
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "none",
    "run_worker_first": [
      "/admin",
      "/admin/*",
      "/api/*",
      "/mcp",
      "/mcp/*",
      "/oauth",
      "/oauth/*",
      "/.well-known/*"
    ]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "my-service-local" }
  ]
}
```

Both compatibility flags are required. `run_worker_first` keeps Admin and Auth on the Worker so a static file cannot shadow them. Local `wrangler dev` creates the D1 database on demand. Omit `MANTLE_AUTH_MODE` here; this entry uses the `auth` factory above. Configure a real `database_id` and a production sender before any remote deploy ([Authentication](../cloudflare/authentication.md)).

## 5. `.dev.vars`

Create `.dev.vars` and do not commit it:

```sh
# 32+ random characters. Example:
# openssl rand -base64 32
BETTER_AUTH_SECRET=
```

## 6. Install, generate, validate, run

```sh
pnpm install
pnpm exec mantle generate
pnpm exec mantle validate
pnpm exec wrangler dev --local
```

`mantle validate` prints `OK  no issues (root: manifests, phase: preview)`. Wrangler prints the local origin, normally `http://localhost:8787`; use whatever it prints below. `generate` writes `.mantle/generated/mantle.ts` and syncs the Admin SPA to `public/_mantle/admin/` because `@aotter/mantle-admin-ui` is installed.

## 7. Probe the Worker

```sh
curl -s http://localhost:8787/api/views/published-notes
```

```json
{ "ok": true, "data": { "rows": [], "page": 1, "show": 20, "hasMore": false } }
```

The View is served with no data because the local D1 is fresh. `show` follows the View's `limit` when the request carries no `?show=`; `?page=` and `?show=` are the reserved pagination params ([Reads: Views, REST and MCP](../concepts/views.md)).

```sh
curl -i http://localhost:8787/
```

`GET /` returns `404`. No visitor frontend is installed or rendered; `mantle-web` is optional composition and never owns an implicit home route. Add your own routes or templates when the product needs them ([Public web, SEO and cache](../cloudflare/public-web.md)).

A public View `200` is not evidence that Admin login works.

## 8. Human milestone: local Admin email OTP

1. Open `http://localhost:8787/admin/sign-in` (or `/admin`, which redirects there).
2. Enter the bootstrap email from step 3.
3. Submit **Send code**. Watch the Wrangler terminal for:

   ```text
   [ConsoleEmailSender] auth.email-otp.sign-in → you@example.com (en)
     subject: Your Mantle sign-in code: 123456
     body: Your one-time code is 123456.
   ```

4. Type that code into Admin and sign in. The first matching email is promoted to `owner`.
5. Open `/admin/dev`. The human learns the service by using Dev UI (model, logic, docs). The agent uses that feedback to refine manifests, then runs `generate` and `validate` again.

If `/admin` says Admin assets are missing, rerun `mantle generate` and confirm the `ASSETS` binding. If the Worker throws `Set BETTER_AUTH_SECRET`, the `.dev.vars` file is missing or empty. `ConsoleEmailSender` is local-only; a remote deploy needs a real `EmailSender`.

This path is not supported yet: reading the OTP without the Wrangler log, and using conventional `MANTLE_AUTH_MODE=self-managed` without GitHub credentials (that combination fails closed with `503 setup_incomplete`).

## What `mantle generate` wrote

- `.mantle/generated/mantle.ts` — one module with the sealed `plan`, generated types (`MantleHandlers<Env>`), `createMantle` and `bindMantle`. The Worker entry above imports `plan`.
- `public/_mantle/admin/` — the Admin SPA, synced because `@aotter/mantle-admin-ui` is installed.

`generate` fails on missing or invalid manifests and never creates a project, a default Schema or a home route. `mantle generate --check` reports stale output without writing. The API-only reference keeps `.mantle/`, `.agents/` and `.claude/` out of git and regenerates them in `check`; see [Project layout and the CLI loop](./project-and-cli.md).

> **npm and optional peers**
> A cold npm install can fail with `ERESOLVE` when an Auth peer selects a different optional `@libsql/client` than this snapshot declares. If that happens, pin `@libsql/client` in `overrides` to the range in this checkout's `package.json` and rerun `npm install`. Do not use `--force`. Commit the lockfile and use `npm ci` afterwards.

## Next steps

- [Project layout and the CLI loop](./project-and-cli.md) — the files you own, every CLI flag, the daily check loop.
- [The four atoms](../concepts/four-atoms.md) — add a Procedure and a Trigger to accept writes.
- [Authentication](../cloudflare/authentication.md) — production GitHub or hosted modes; replace `ConsoleEmailSender` before any remote deploy.
- [Public web, SEO and cache](../cloudflare/public-web.md) — give the service a rendered public surface when the product needs one.

## Source
- [`docs/examples/minimal-worker/README.md`](../../../docs/examples/minimal-worker/README.md)
- [`docs/examples/minimal-worker/package.json`](../../../docs/examples/minimal-worker/package.json)
- [`docs/examples/minimal-worker/tsconfig.json`](../../../docs/examples/minimal-worker/tsconfig.json)
- [`docs/examples/minimal-worker/manifests/site.yaml`](../../../docs/examples/minimal-worker/manifests/site.yaml)
- [`docs/examples/minimal-worker/src/index.ts`](../../../docs/examples/minimal-worker/src/index.ts)
- [`docs/examples/minimal-worker/wrangler.jsonc`](../../../docs/examples/minimal-worker/wrangler.jsonc)
- [`packages/adapters/cloudflare/src/auth/ConsoleEmailSender.ts`](../../../packages/adapters/cloudflare/src/auth/ConsoleEmailSender.ts)
- [`packages/adapters/cloudflare/src/auth/createAuth.ts`](../../../packages/adapters/cloudflare/src/auth/createAuth.ts)
- [`docs/direct-authoring.md`](../../../docs/direct-authoring.md)
- [`packages/mantle-runtime/src/domain/service/Pagination.ts`](../../../packages/mantle-runtime/src/domain/service/Pagination.ts)
