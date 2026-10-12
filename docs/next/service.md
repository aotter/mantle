# Application-owned service composition

The app owns `fetch`, native database handles, pools, auth options and deployment.
Select generated modules by importing them; omitted modules stay out of the bundle.
There is no runtime plan, framework or `withCaller` wrapper. Keep this source outside
the generated directory. The [auth template](auth.md), [surface contracts](surfaces.md)
and [media wiring](media.md) describe the selected capabilities.

Mount auth (including discovery), consent, Admin, MCP and REST in that order,
matching 0.2. `authRoutes` owns both auth and consent paths. Supply one lazy,
request-local resolver to those surfaces: a request resolves at most once, and
all cookie-session mutations use the shared origin check. A custom identity
supplies the same verified `Caller`; absent directory/role facets remain absent.
Never construct a system Caller from credentials or request input.

```ts
// src/worker.ts — application-owned; choose imports for the features you use.
import { authLoader, resolveCaller } from '@aotter/mantle/auth';
import { authRoutes } from '@aotter/mantle/auth/routes';
import { checkOrigin, surfaceFailure, type Caller } from '@aotter/mantle/contracts';
import { admin } from '../generated/admin.js';
import { mcp } from '../generated/mcp.js';
import { rest } from '../generated/rest.js';
import { handlers } from './handlers.js'; // omit when there are no ref Procedures

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  ADMIN_EMAIL: string;
}
let auth: ReturnType<typeof authLoader> | undefined;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    auth ??= authLoader(() => import('./auth.js').then(m => m.createAuth(env)));
    const headers = new Headers(); // retain Better Auth's sliding-session cookies
    let authority: Promise<Caller> | undefined;
    const caller = () => authority ??= resolveCaller(request, auth!, {
      audience: [`${env.ORIGIN}/mcp`, `${env.ORIGIN}/mcp/staff`],
      responseHeaders: headers,
    }).then(value => { checkOrigin(request, value); return value; });
    const options = { db: (env: Env) => env.DB, caller, handlers };
    const routes = [
      authRoutes(auth, { methods: [{ kind: 'email-otp' }], resolver: caller }),
      admin({ ...options, assets: (path, req, env) => env.ASSETS.fetch(new Request(new URL(path, req.url), req)) }),
      mcp(options),
      rest(options),
    ];
    try {
      for (const route of routes) {
        const response = await route(request, env);
        if (!response) continue;
        if (!headers.getSetCookie().length) return response;
        const result = new Response(response.body, response);
        for (const cookie of headers.getSetCookie()) result.headers.append('set-cookie', cookie);
        return result;
      }
      // Your public frontend/web.ts routes can use an anonymous Caller without
      // loading auth; their generated SQL still controls publication visibility.
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return surfaceFailure(error); }
  },
};
```

Remove imports and array entries for omitted surfaces. `mcp.ts` exists only when
the manifest has an MCP surface, and requires the documented optional MCP peer.
Pass the same handlers to each selected surface that exposes ref Procedures.
Bind site/media/identity and extension capabilities through the selected Admin/MCP
options; do not expose native auth administrative routes without `authRoutes` or
`guardAuthAdminRequest`. Auth background callbacks on Workers use the documented
`withAuthTasks(ctx.waitUntil.bind(ctx), ...)` integration, not another request's context.

## Workers assets and secrets

`mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts`
updates the split-build Wrangler keys. Configure the rest explicitly; JSONC
comments and unrelated settings survive regeneration:

```jsonc
{
  "assets": {
    "directory": "node_modules/@aotter/mantle-ui/dist/admin",
    "binding": "ASSETS",
    "run_worker_first": true,
    "html_handling": "none"
  },
  "d1_databases": [{ "binding": "DB", "database_name": "your-database", "database_id": "your-id" }]
}
```

`run_worker_first` lets Admin supply its shell/security/cache headers; `none`
keeps `index.html` available by name. Admin assets are not a public database API.
Use the installed release's documented Admin asset directory; package assembly
may move it. PostgreSQL uses application-owned Hyperdrive/postgres.js wiring,
with Hyperdrive query caching disabled for authority and mutation visibility.

Commit `.dev.vars.example` containing variable names and placeholders only:

```dotenv
ORIGIN=http://localhost:8787
ADMIN_EMAIL=you@example.test
BETTER_AUTH_SECRET=replace-with-a-random-secret
```

Copy it to ignored `.dev.vars`; use deployment secrets for production. The auth
module wires `ADMIN_EMAIL` to the bootstrap helper, which requires verified email.
`PUBLIC_ORIGIN` can be your application variable instead of `ORIGIN`; map it
explicitly when constructing auth and keep the trusted origin consistent.

## Scheduling and Bun

Scheduling remains app-owned; schedule/lifecycle Triggers are refused. Import
only the desired generated `sweepExpired` entry in `scheduled()`, pass a system
Caller with a reason, and cap each invocation at 20 pages as in the
[TTL contract](contract.md#ttl-maintenance). Configure `triggers.crons` yourself;
`toCloudflareCron` converts POSIX schedules without adding a dispatcher. Keep
larger sweeps' cursors for a later invocation instead of scanning without a bound.

On Bun, reuse a process-owned `Database` or `SQL` pool and call the same generated
surfaces from `Bun.serve({fetch})`. The optional host reader is independent of
SQLite and Core:

```ts
import { bunAdminAssets } from '@aotter/mantle/bun/assets';
const assets = bunAdminAssets('node_modules/@aotter/mantle-ui/dist/admin');
const serveAdmin = admin({ db: () => db, caller, assets, handlers });
```

The reader returns a native `Response` or `null`, rejects traversal/control
characters and escaping symlinks; Admin owns MIME, shell and cache headers.
Use ignored `.env` on Bun. Run cron work with your native scheduler; neither
imports nor `fetch` execute DDL, migration, seeding or cron work.

## Commit generated output and verify it in CI

Commit every file written by `mantle generate`: TypeScript, `schema.sql`, optional
seed SQL and Wrangler edits. Never hand-edit generated output. Every emitted
TypeScript/SQL file carries the ownership header. Add the line printed by
generation to `.gitattributes`, for example:

```gitattributes
generated/** linguist-generated=true
```

Resolve generated merge conflicts by merging authored manifests/options first,
then regenerating with the same options. Review the SQL/policy diff and write
explicit migrations before deployment. Keep `dist/` (the `mantle bundle` output)
untracked. Deployment uses committed generated source; it does not regenerate.

```sh
# CI, with the project's exact installed SDK and peer versions:
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts --check
pnpm exec tsc --noEmit
pnpm exec mantle bundle src/worker.ts dist
```

`--check` regenerates in memory, lists missing/changed/obsolete SDK-owned files
and stale Wrangler build settings, exits nonzero, and writes nothing. Unmarked
application files are preserved. TOML generation prints manual edits, so an
exact Wrangler `--check` requires JSON/JSONC. Use all the same `--site`, `--auth`
and `--admin-extensions` options as normal generation. The check needs no database,
network access, credentials or deployment. Imported configuration modules must
remain pure: exporting `authOptions(env)` avoids constructing Better Auth at build time.
