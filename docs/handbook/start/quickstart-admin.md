---
description: "Open local Admin in one shot: generate the prebuilt SPA, bind ASSETS, sign in with email OTP from wrangler logs, land in the Dev UI."
---
# Quickstart: local Admin

This page reproduces Core's local Admin OTP reference as a from-scratch walkthrough. Admin is **opt-in**: use it when humans need a Dev UI. A complete Mantle service does not require this surface. Install every `@aotter/mantle*` package from the `latest` dist-tag; see [Versions](../reference/surface.md#versions).

The default embed path — Spec + Worker without Admin — is [Quickstart: a minimal Worker](./quickstart-worker.md).

## Prerequisites

- Node.js 22 or newer.
- pnpm 9 or newer. The reference is tested with pnpm.
- `wrangler` is installed as a project devDependency below. No Cloudflare account, D1 database id or production secret is needed for the local loop.

An agent interviews the human for one value before writing files: the bootstrap owner email. The example uses `owner@example.com`.

## 1. `package.json`

Install every `@aotter/mantle*` package from the `latest` dist-tag. Admin needs both `@aotter/mantle-admin` and `@aotter/mantle-admin-ui` plus the Cloudflare adapter peers.

```json
{
  "name": "mantle-local-admin-otp",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "mantle generate",
    "validate": "mantle validate",
    "typecheck": "tsc --noEmit",
    "predev": "node ensure-dev-vars.mjs",
    "dev": "wrangler dev --local --ip 127.0.0.1 --port 8787"
  },
  "dependencies": {
    "@aotter/mantle": "latest",
    "@aotter/mantle-admin": "latest",
    "@aotter/mantle-admin-ui": "latest",
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

`ensure-dev-vars.mjs` copies the example vars on first `pnpm dev`:

```js
import { copyFileSync, existsSync } from "node:fs";
if (!existsSync(".dev.vars")) copyFileSync(".dev.vars.example", ".dev.vars");
```

## 2. `.dev.vars.example`

```sh
PUBLIC_ORIGIN=http://127.0.0.1:8787
BETTER_AUTH_SECRET=local-admin-otp-dev-secret-do-not-use-in-prod
ADMIN_EMAIL=owner@example.com
```

Copy it to `.dev.vars` (the `predev` script does this). Never commit `.dev.vars`. `pnpm dev` binds `127.0.0.1:8787` so wrangler's Ready-on origin matches this `PUBLIC_ORIGIN`. A mismatch makes Better Auth reject OTP with `INVALID_ORIGIN`.

## 3. `manifests/site.yaml`

One publishing Schema and one public View. `mantle generate` never invents a Schema; this notes model is example business data. `cache` is valid in this snapshot's grammar.

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

Use the docs that ship with the pinned version. A newer handbook page is not a contract for an older install.

## 4. `src/index.ts`

Replace conventional GitHub Auth construction with local email OTP. Core still owns `/admin` and `/api/auth/*`.

```ts
import {
  ConsoleEmailSender,
  createAuth,
  createMantleWorker,
  type MantleCloudflareEnv,
} from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export interface Env extends MantleCloudflareEnv {
  readonly ASSETS: Fetcher;
  readonly BETTER_AUTH_SECRET: string;
  readonly ADMIN_EMAIL: string;
}

const sender = new ConsoleEmailSender();

export default createMantleWorker<Env>({
  plan,
  cacheScope: "local-admin-otp",
  siteDefaults: (env) => ({
    brand: "Local Admin",
    title: "Local Admin",
    origin: env.PUBLIC_ORIGIN?.replace(/\/+$/, "") ?? "http://127.0.0.1:8787",
  }),
  auth: (env) => {
    const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "") ?? "http://127.0.0.1:8787";
    return createAuth({
      database: env.DB,
      baseURL: origin,
      secret: env.BETTER_AUTH_SECRET,
      methods: [{ kind: "email-otp", sender }],
      bootstrapOwner: { match: "email", value: env.ADMIN_EMAIL },
      oauthProvider: {
        loginPage: "/admin/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["mcp"],
        mcpResource: `${origin}/mcp`,
      },
    });
  },
});
```

`ConsoleEmailSender` writes the OTP to wrangler logs. It is the local human path. Do not wire it in production.

## 5. `wrangler.jsonc`

Admin requires Static Assets. This is not optional.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mantle-local-admin-otp",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-08",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "d1_databases": [
    { "binding": "DB", "database_name": "mantle-local-admin-otp" }
  ]
}
```

Keep a `public/` directory (empty is fine). `generate` writes `public/_mantle/admin/` into it. Do not put `/_mantle` in `run_worker_first`: those files must be served by the assets layer. A Worker-first catch-all without asset fallthrough is the white-screen class of bug — `/admin` returns SPA HTML `200` while `/_mantle/admin/assets/*` is `404`.

## 6. Install, generate, run

```sh
pnpm install && pnpm generate && pnpm dev
```

`mantle generate` writes `.mantle/generated/mantle.ts` and syncs the **prebuilt** Admin SPA from `@aotter/mantle-admin-ui` into `public/_mantle/admin/`. Do not run Vite or otherwise build a frontend unless you are developing `admin-ui` itself.

`pnpm dev` binds `127.0.0.1:8787`. Wrangler prints `Ready on http://127.0.0.1:8787`, the same origin as `PUBLIC_ORIGIN`. Open that Ready-on URL. Browsing `http://localhost:8787` still serves HTML, but the OTP Origin header mismatches `PUBLIC_ORIGIN` and Better Auth returns `INVALID_ORIGIN`.

## 7. Sign in

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/admin/sign-in
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/_mantle/admin/index.html
```

Both are `200`. Open `/admin/sign-in`, submit the bootstrap owner email, then read the wrangler log:

```text
[ConsoleEmailSender] auth.email-otp.sign-in → owner@example.com (en)
  subject: Your Mantle sign-in code: 123456
```

Enter the code. The first matching sign-in is promoted to `owner` and the Admin shell loads.

If the page is blank, fetch an asset URL from the HTML. A `404` there means `ASSETS` is missing or `run_worker_first` swallowed `/_mantle`. That is not a missing `vite build`.

## What `mantle generate` wrote

- `.mantle/generated/mantle.ts` — the sealed `plan`, generated types, `createMantle` and `bindMantle`.
- `public/_mantle/admin/` — the prebuilt Admin SPA. Required for `/admin`.

`generate` fails on missing or invalid manifests and never creates a project, a default Schema or a home route. The reference keeps `.mantle/`, `.agents/`, `.claude/` and `public/_mantle/` out of git and regenerates them in `check`; see [Project layout and the CLI loop](./project-and-cli.md).

## Next steps

- [Project layout and the CLI loop](./project-and-cli.md) — the files you own, every CLI flag, the daily check loop, ASSETS as a hard Admin requirement.
- [Authentication](../cloudflare/authentication.md) — production senders, GitHub / hosted modes, roles.
- [The conventional Worker](../cloudflare/conventional-worker.md) — handlers and extra routes.
- [Quickstart: a minimal Worker](./quickstart-worker.md) — API-only embed without Admin.

## Source
- [`docs/examples/host-local-admin-otp/README.md`](../../../docs/examples/host-local-admin-otp/README.md)
- [`docs/examples/host-local-admin-otp/package.json`](../../../docs/examples/host-local-admin-otp/package.json)
- [`docs/examples/host-local-admin-otp/src/index.ts`](../../../docs/examples/host-local-admin-otp/src/index.ts)
- [`docs/examples/host-local-admin-otp/wrangler.jsonc`](../../../docs/examples/host-local-admin-otp/wrangler.jsonc)
- [`docs/examples/host-local-admin-otp/.dev.vars.example`](../../../docs/examples/host-local-admin-otp/.dev.vars.example)
- [`docs/examples/host-local-admin-otp/smoke.mjs`](../../../docs/examples/host-local-admin-otp/smoke.mjs)
