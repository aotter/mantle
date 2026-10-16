# Application-owned service composition

Read the exact installed SDK/Admin versions. The [Native Admin guide](../guides/native-admin.md)
is the authority for generated collection bindings and retained console behavior.

The app owns `fetch`, native database handles, pools, auth options and deployment.
Select generated modules by importing them; omitted modules stay out of the bundle.
Keep application routing source outside
the generated directory. The [auth template](authentication.md), [surface contracts](../reference/surface.md)
and [media wiring](media-r2.md) describe the selected capabilities.

Mount auth (including discovery), consent, Admin, MCP and REST in that order,
matching 0.2. `authRoutes` owns both auth and consent paths. Supply one lazy,
request-local resolver to those surfaces, memoizing read-only and fresh authority
separately so a cached read cannot authorize a write. All cookie-session mutations
use the shared origin check. A custom identity
supplies the same verified `Caller`; absent directory/role facets remain absent.
Never construct a system Caller from credentials or request input.

Generate `Env` from the Wrangler config; do not hand-write it. Declare secrets
under `secrets.required`, run `pnpm exec wrangler types --include-runtime=false`,
add `worker-configuration.d.ts` to `tsconfig.json` and commit it.
`@cloudflare/workers-types` still supplies runtime types. Rerun after every binding
change; `wrangler types --include-runtime=false --check` fails on drift.
Once `secrets.required` is set, `wrangler dev` loads only those keys from
`.dev.vars`/`.env`, so declare every secret the app reads.

```ts
// src/worker.ts — application-owned; choose imports for the features you use.
import { authLoader, resolveCaller } from '@aotter/mantle/auth';
import { authRoutes } from '@aotter/mantle/auth/routes';
import { withAuthTasks } from '@aotter/mantle/auth/hardening';
import { checkOrigin, surfaceFailure, type Caller } from '@aotter/mantle/contracts';
import { admin, adminShell } from '@aotter/mantle-admin/server';
import { adminMcpApps } from '@aotter/mantle-admin/mcp';
import { entries } from '@aotter/mantle-admin/server/entries';
import { adminBindings } from '../generated/admin-bindings.js';
import { mcpAppCatalogues } from '../generated/admin-descriptors.js';
import { mcp } from '../generated/mcp.js';
import { rest } from '../generated/rest.js';
import { handlers } from './handlers.js'; // omit when there are no ref Procedures

// Env comes from worker-configuration.d.ts: declare DB, ASSETS, the email provider binding
// and the PUBLIC_ORIGIN, BETTER_AUTH_SECRET and ADMIN_EMAIL secrets in Wrangler.
// createAuth(env) is exported by the app's src/auth.ts (see the auth template).
let auth: import('@aotter/mantle/auth').AuthLoader<ReturnType<typeof import('./auth.js').createAuth>> | undefined;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withAuthTasks(ctx.waitUntil.bind(ctx), async () => {
      auth ??= authLoader(() => import('./auth.js').then(m => m.createAuth(env)));
      const headers = new Headers(); // retain Better Auth's sliding-session cookies
      let authority: Promise<Caller> | undefined, readAuthority: Promise<Caller> | undefined;
      const resolve = (readOnly: boolean) => resolveCaller(request, auth!, {
        readOnly,
        audience: [`${env.PUBLIC_ORIGIN}/mcp`, `${env.PUBLIC_ORIGIN}/mcp/admin`],
        responseHeaders: headers,
      }).then(value => { checkOrigin(request, value); return value; });
      const caller = (_request?: Request, _env?: Env, classification = { readOnly: false }) =>
        classification.readOnly ? readAuthority ??= resolve(true) : authority ??= resolve(false);
      const options = { db: (env: Env) => env.DB, caller, handlers };
      const bindings = adminBindings({ handlers }); // use adminBindings() without ref Procedures
      const routes = [
        authRoutes(auth, { methods: [{ kind: 'email-otp' }], resolver: caller }),
        admin(bindings.metadata, bindings.views, bindings.operations, {
          ...options, developerViews: bindings.developerViews, routes: entries(bindings.schemas, bindings.adapter),
        }),
        mcp({ ...options, apps: { admin: adminMcpApps({ catalogue: mcpAppCatalogues.admin }) } }),
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
        // Serves the built Admin shell for /admin and its client routes; undefined for any other path.
        const shell = await adminShell(request, path => env.ASSETS.fetch(new Request(new URL('/admin/' + path, request.url), request)));
        if (shell) return shell;
        // Your public frontend/web.ts routes can use an anonymous Caller without
        // loading auth; their generated SQL still controls publication visibility.
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return surfaceFailure(error); }
    });
  },
};
```

Remove imports and array entries for omitted surfaces. `mcp.ts` exists only when
the manifest has an MCP surface, and requires the documented optional MCP peer.
Pass the same handlers to each selected surface that exposes ref Procedures.
Bind site/media/identity capabilities through the selected Admin/MCP
options; do not expose native auth administrative routes without `authRoutes` or
`guardAuthAdminRequest`. `withAuthTasks` retains background callbacks on the
current request's context; `authHardening` configures the background handler.
Select `--admin` to emit `admin-bindings.ts`. Admin's API is a separate
`@aotter/mantle-admin` package; the SDK never imports it. The API handles only
`/admin/api`. `adminShell` (in the block above) serves the built shell for `/admin` and
client routes, including `/admin/sign-in`; it sets `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `no-store` and `nosniff`
on the shell, answers a missing file under `/admin` with a 404 `Response`, and returns `undefined` for other paths and
non-GET requests. The app owns the rest of the CSP and the asset cache headers.
Collection statistics use the generated shared `statisticsView`:
its collection parameter selects only a generated table and visibility policy.

## Workers assets and secrets

`mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts --admin`
updates the split-build Wrangler keys (`main` and `base_dir` under `dist/worker`),
ensures `nodejs_compat` and defaults to `global_fetch_strictly_public` ([public fetch routing](deploy-and-operate.md#public-fetch-routing))
and, with `--admin`, `assets.directory`: `mantle bundle` builds Admin into
`dist/client/admin`, served at `/admin`. Configure the rest explicitly; JSONC
comments and unrelated settings survive regeneration:

```jsonc
{
  "assets": {
    "directory": "dist/client",
    "binding": "ASSETS",
    "run_worker_first": true,
    "html_handling": "none"
  },
  "d1_databases": [{ "binding": "DB", "database_name": "your-database", "database_id": "your-id" }]
}
```

`run_worker_first` lets the application supply shell/security/cache headers;
`none` keeps `index.html` available by name. `adminShell(request, assets)` passes
paths relative to the Admin directory, so the app fetches them under `/admin/`:
`path => env.ASSETS.fetch(new Request(new URL("/admin/" + path, request.url), request))`. Admin assets are not a public database
API. PostgreSQL uses application-owned Hyperdrive/postgres.js wiring,
with Hyperdrive query caching disabled for authority and mutation visibility.

Commit `.dev.vars.example` containing variable names and placeholders only:

```dotenv
PUBLIC_ORIGIN=http://localhost:8787
ADMIN_EMAIL=you@example.test
BETTER_AUTH_SECRET=replace-with-a-random-secret
```

Copy it to ignored `.dev.vars`; use deployment secrets for production. Configure
an app-owned [`EmailSender`](../guides/email.md#application-wiring) and call its
`send({ to, subject, text, html?, locale, category? })` from Better Auth's email
callbacks. Adapt the auth template's `MAIL.otp`/`MAIL.link` callbacks to this
sender; it is an object, not a `.dev.vars` value. The auth
module wires `ADMIN_EMAIL` to the bootstrap helper, which requires verified email.
Name the variables as your `auth.ts` reads them (the app shell uses these three) and keep the trusted origin consistent.

## Scheduling and Bun

Scheduling remains app-owned; schedule/lifecycle Triggers are refused. Import
only the desired generated `sweepExpired` entry in `scheduled()`, pass a system
Caller with a reason, and choose an application-owned page budget for each
invocation; see the [TTL contract](../guides/native-execution.md#ttl-maintenance). Configure `triggers.crons` yourself;
`toCloudflareCron` converts POSIX schedules without adding a dispatcher. Keep
larger sweeps' cursors for a later invocation instead of scanning without a bound.

On Bun, reuse a process-owned `Database` or `SQL` pool and call the same generated
surfaces from `Bun.serve({fetch})`. Bun runs the server as TypeScript, so
`mantle bundle` builds only Admin for it: the `bun-*` target that
`generated/.mantle-inputs.json` records skips the Worker bundle, and Admin goes
to `dist/client/admin` (`--assets` as on Workers) when the server imports
`@aotter/mantle-admin/server`. Add it as the build script and run it before
starting the server:

```json
{ "scripts": { "build": "mantle bundle src/server.ts dist" } }
```

The optional host reader is independent of the query target:

```ts
import { bunAdminAssets } from '@aotter/mantle/bun/assets';
const assets = bunAdminAssets('dist/client/admin');
const bindings = adminBindings({ handlers });
const serveAdmin = admin(bindings.metadata, bindings.views, bindings.operations, {
  db: () => db, caller, handlers, routes: entries(bindings.schemas, bindings.adapter),
});
// Call assets(path) from your separate shell/static route. adminShell(request, reader) wants
// paths without a leading slash and a Response (404 when missing), so adapt the reader:
const reader = async (path: string) => (await assets('/' + path)) ?? new Response(null, { status: 404 });
```

The reader returns a native `Response` or `null`, rejects traversal/control
characters and escaping symlinks; the app owns shell, CSP and cache headers.
Use ignored `.env` on Bun.

Admin's build tools and UI packages are dependencies of `@aotter/mantle-admin`,
so a production install carries them (about 65 MB). For a container image, use a
multi-stage build: the build stage installs everything and runs `mantle bundle`
and `bun build src/server.ts --target bun --outdir dist/server`; the runtime stage
copies only `dist/` (plus any files the server reads at runtime) and starts
`bun dist/server/server.js`. Neither the Admin assets nor the bundled server read
`node_modules` once built. Run cron work with your native scheduler; neither
imports nor ordinary requests execute DDL, migrations or cron work. OAuth resource
rows are inserted on first OAuth use from runtime configuration, with no deploy
step; auth initialization and cookie/bearer/MCP/REST requests do no resource work.

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
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts --admin --check
pnpm exec tsc --noEmit
pnpm exec mantle bundle src/worker.ts dist   # dist/worker, and dist/client/admin with --admin
```

`--check` regenerates in memory, lists missing/changed/obsolete SDK-owned files
and stale Wrangler build settings, exits nonzero, and writes nothing. Unmarked
application files are preserved. TOML generation prints manual edits, so an
exact Wrangler `--check` requires JSON/JSONC. Use all the same `--site`, `--auth` and `--admin` options as normal generation. The check needs no database,
network access, credentials or deployment. Imported configuration modules must
remain pure: exporting `authOptions(env)` avoids constructing Better Auth at build time.
