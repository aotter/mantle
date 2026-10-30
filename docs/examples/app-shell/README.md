# App shell

The wiring every Mantle Cloudflare app needs, ready to copy: Better Auth (email OTP, admin + user roles),
one Worker fetch (auth routes → your routes → Admin → MCP → generated REST), the Admin console assets, and a
local acceptance kit. It has no business manifests: add your own, taking patterns from the examples (`mantle help examples`).

## Start an app

```sh
npx @aotter/mantle@<exact version> init my-app   # writes this shell once, Mantle packages pinned to that version
cd my-app
pnpm install
# add manifests/*.yaml (mantle help four-atoms; patterns: mantle help examples)
pnpm generate          # writes generated/ and lists any `handler: { ref }` to implement in src/handlers.ts
pnpm types && pnpm check       # each builds once (see Which steps build)
cp .dev.vars.example .dev.vars
pnpm db:init                   # optional seed.sql for static reference data, then pnpm db:seed (see Seed data)
pnpm dev                       # builds, rebuilds on change; one-time codes print to this log
pnpm smoke                     # builds; runs smoke.mjs, which you write on smoke-kit.mjs (init does not create it)
pnpm accept                    # builds; prints a signed-in URL per role for fresh evaluators (see Independent acceptance)
pnpm test                      # Admin MCP App check of the last build: needs Chrome (npx playwright-core install chromium, or MANTLE_TEST_CHROMIUM=<executable>)
```

### Which steps build

`wrangler.jsonc` sets `mantle bundle src/index.ts dist` as Wrangler's custom build. These steps run it (marked
**builds**); the others do not:

| Step | Builds? |
|---|---|
| `pnpm generate`, `pnpm db:init`, `pnpm db:seed` | no |
| `pnpm test` | no; it tests the last build |
| `pnpm types` (`wrangler types`) | **builds**: Wrangler reads the built entry's exports for Durable Object and service binding types |
| `pnpm check` | **builds** once, in `wrangler types --check`; `generate --check` and `tsc` do not |
| `pnpm build` | **builds** |
| `pnpm dev` | **builds** at start, then again on every change under `src/` or `generated/` |
| `pnpm smoke`, `pnpm accept` | **build** once each: both start `wrangler dev` |

Wrangler has no option to skip the custom build for `wrangler types`. The Admin console is rebuilt only when the
installed Admin packages change or the app has `src/admin.tsx`, so a repeated build mostly rebuilds the Worker.

First run, after `pnpm install` and your manifests: `pnpm generate`, `pnpm types`, `pnpm check`,
`cp .dev.vars.example .dev.vars` (`pnpm dev` needs the secrets `wrangler.jsonc` requires), `pnpm db:init`, then
`pnpm dev` or `pnpm smoke`. Right after `pnpm types`, `pnpm check` repeats its build; run it anyway, because it is the
same check CI and hand-off use.

Routine edit, with `pnpm dev` running:

1. Edit `manifests/*.yaml`, then `pnpm generate`. Wrangler does not watch `manifests/`, so the last build keeps
   serving until something under `src/` or `generated/` changes. From the next change under `src/` until you
   generate, each change prints one line, `Generated output in generated is stale (...)`, and the dev server holds
   requests instead of running stale code. Writing `generated/` rebuilds. If you undo the manifest edit instead,
   nothing rebuilds until the next change under `src/` or a restart of `pnpm dev`.
2. `pnpm types` only when `generate` or you changed `wrangler.jsonc` (bindings, secrets, vars).
3. Edits under `src/` rebuild by themselves.
4. Before handing off: `pnpm check`, then `pnpm smoke`.

npm works too (`npm install`, `npm run …`). `package.json` pins `@better-auth/core` and `@better-auth/utils` even though
the shell does not import them: they are the exact versions the SDK's Better Auth peers require, and without them a fresh
install resolves newer ones (npm ERESOLVE, or a second Better Auth type tree under pnpm). Keep every Better Auth package
on one version.

## Files you edit

| File | What it is for |
|---|---|
| `manifests/*.yaml` | Your Schemas, Views, Procedures and Triggers. `pnpm generate` compiles every file here. |
| `src/handlers.ts` | Code for each `handler: { ref }` Procedure. The Store it receives is bound to the same caller. |
| `src/routes.ts` | App-owned routes: visitor pages, SEO files, webhooks and callbacks. |
| `src/admin.tsx` | Optional, not shipped: the Admin entry (`defineAdmin(admin, { nav, pages, home, components, plugins, mcp })`) `mantle bundle` builds instead of the built-in one. Add it to group the sidebar or replace Admin regions; see docs/handbook/guides/native-admin.md. |
| `src/sign-in.ts` | Member sign-in page at `/sign-in` (email code, then back to `?return=`) and `signInRedirect(request)` for pages that need a signed-in visitor. Unstyled; delete it if the app has no member pages. |
| `src/schedule.ts` | Cron work. Add the cron to `wrangler.jsonc` `triggers.crons`. |
| `src/signup.ts` | `allowSignUp(env, email)`: who may create an account (allow-all by default). `auth.ts` calls it before Better Auth creates a user; `ADMIN_EMAIL` is always allowed. |
| `src/auth.ts` | Better Auth options. Two roles only: `admin` (the admin layer) and `user`. Replace the console OTP sender before deploying. |
| `smoke.mjs` | Your acceptance steps on `smoke-kit.mjs` (fresh local D1, OTP sign-in per user, REST/MCP/Admin calls). |
| `accept.mjs` | Independent acceptance setup: one URL per role that carries its session, plus a minimal MCP client. Add a fixtures module for realistic data. |

`src/service.ts` and `src/index.ts` rarely change. The default shell mounts REST and MCP together. If the app deliberately
chooses asymmetric exposure, delete the blocks marked `MCP / OAuth (deliberate exception)` in `auth.ts` and `service.ts`;
HTTP-only Procedures will keep generating with a warning.

Search for `AGENT:` to find what an app must fill in.

## Seed data

Create test records through the app: your `smoke.mjs` or an `accept.mjs` fixtures module calls the app's own REST, MCP
or Admin operations as a signed-in user, so Mantle fills `id`, `version`, `created_at`, `updated_at`, `author_id`
and the publishing `status`/`published_at`. Keep `seed.sql` for static reference data no surface writes; native SQL
must set those columns itself, timestamps as integer microseconds on D1. An omitted `updated_at` stores `0`, which
Admin shows as 1970. `mantle help local-testing` (Seed data) has a complete seed:

```sql
INSERT INTO categories (id, version, created_at, updated_at, name) VALUES
  ('books', 1, 1767225600000000, 1767225600000000, 'Books');
```

## Local testing notes

- Better Auth allows 3 OTP requests per minute per client IP. `smoke-kit.mjs` gives each user its own
  `cf-connecting-ip`; when testing by hand, wait a minute or vary that header.
- `ADMIN_EMAIL`'s first verified sign-in becomes `admin` while no admin exists. The sign-in response may still show
  the previous role; `/admin/api/me` shows the current one.
- More administrators: in Admin, **More → Administrators** invites by email and **More → Members** grants Admin to an
  existing member. `docs/handbook/cloudflare/authentication.md` (Identity helpers) has the same operations as an API.
- Admin HTTP routes are listed in `docs/handbook/guides/native-admin.md`.

`mantle help local-testing` lists what the smoke covers: every Procedure at its edges, each caller's isolation,
visitor pages without JavaScript, MCP discovery and Admin's MCP App.
Scripted smoke is not independent acceptance; before reporting a user-facing
deliverable done, follow the independent acceptance guide: `mantle help agent-workflow-acceptance`. Hand off with
its layered report ("Report done-ness in layers"): smoke and `pnpm test` are layer 2, `pnpm accept` rounds layer 3.

### Independent acceptance

`pnpm accept` (optionally `pnpm accept --fixtures fixtures.mjs --user member@example.test`, and `--open` to open the signed-in admin's Developer UI in your browser; with npm, `npm run accept -- --fixtures …`) starts the app on a fresh local D1,
signs the admin in, runs your fixtures module, signs the user in and prints one local URL per role:

```text
visitor (anonymous): http://127.0.0.1:18741
admin (owner@example.test): http://127.0.0.1:46467  MCP http://127.0.0.1:46467/mcp/admin  Admin http://127.0.0.1:46467/admin
user (member@example.test): http://127.0.0.1:42607  MCP http://127.0.0.1:42607/mcp
```

Each URL forwards to the app with that role's session; the evaluator never sees a cookie, and the URL refuses
`/api/auth/*`, so it cannot sign out, sign in as someone else or mint credentials. Give an evaluator only its role's URL:

- MCP: configure the URL as a streamable HTTP MCP server, or, without an MCP client,
  `node accept.mjs mcp <url>/mcp` lists the tools and `node accept.mjs mcp <url>/mcp <tool> '<json>'` calls one.
- Admin and member pages: open the URL in a browser (a person's, or Playwright for an agent); it is already
  signed in.
- REST: send requests to the URL with no credential.

The fixtures module's default export receives `{ call, mcp, signIn, sql, sessions, user }` and runs between the two
sign-ins, so an invite-only app can admit the user first. Create records through the app's own REST/MCP as real
users (other members' records, several states, more than one page); `sql` is for what no surface may write, and returns storage column names (lower case unless aliased).
Ctrl-C stops the app and deletes its data. To accept an external MCP host's OAuth connection instead, see the guide.

### MCP acceptance

Generation declares tools; the app owns whether and where a remote endpoint is mounted.
In your `smoke.mjs`, reuse the generated static tool names rather than maintaining a second list:

```js
import assert from "node:assert/strict";
import { assertMcpDiscovery, smoke } from "./smoke-kit.mjs";
import { developerConsole } from "./generated/admin-descriptors.ts";

await smoke(async ({ origin, owner, signIn, mcp }) => {
  const cookie = await signIn(owner);
  const tools = developerConsole.interfaces.callable.filter(tool => tool.surface === "admin");
  await assertMcpDiscovery(`${origin}/mcp/admin`, { tools, headers: { cookie, origin } });
  // Denial is a separate assertion, not successful discovery.
  assert.equal((await mcp("/mcp/admin")).status, 401);
});
```

Node 22.22+ can read this pure static
TypeScript descriptor directly; no generated request handlers are executed to derive expected names.
A TypeScript smoke scenario can instead import `tools` from generated `mcp.ts`.
Explicitly select the permitted subset if the app narrows authorization, and include any app-composed tools.
The assertion initializes MCP, forwards supplied identity/session headers, reads all tools/list pages,
and compares exact names without calling business tools. JSON/SSE protocol failures, missing routes,
unexpected/missing tools and repeated/excessive pagination fail; it never obtains credentials or mounts routes.

This local cookie test does not prove OAuth Bearer or an external client's connection. Test those separately
with supplied credentials and record their results as layer 4 of the layered report. For each declared interface,
the existing handoff/README/test report must say verified (command, identity and result), intentionally not exposed,
or deferred/unverified with a reason. WebMCP-only applications remain valid; an interrupted preview must retain the remote acceptance item
as deferred rather than silently claiming completion.
