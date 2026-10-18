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
pnpm types && pnpm check
cp .dev.vars.example .dev.vars
pnpm db:init                   # add seed.sql and run pnpm db:seed for fixtures
pnpm dev                       # one-time codes print to this log
pnpm smoke                     # your smoke.mjs on smoke-kit.mjs (see Files you edit)
pnpm test                      # Admin MCP App check: needs Chrome (npx playwright-core install chromium, or MANTLE_TEST_CHROMIUM=<executable>)
```

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

`src/service.ts` and `src/index.ts` rarely change. The default shell mounts REST and MCP together. If the app deliberately
chooses asymmetric exposure, delete the blocks marked `MCP / OAuth (deliberate exception)` in `auth.ts` and `service.ts`;
HTTP-only Procedures will keep generating with a warning.

Search for `AGENT:` to find what an app must fill in.

## Local testing notes

- Better Auth allows 3 OTP requests per minute per client IP. `smoke-kit.mjs` gives each user its own
  `cf-connecting-ip`; when testing by hand, wait a minute or vary that header.
- `ADMIN_EMAIL`'s first verified sign-in becomes `admin` while no admin exists. The sign-in response may still show
  the previous role; `/admin/api/me` shows the current one.
- Admin HTTP routes are listed in `docs/handbook/guides/native-admin.md`.

Scripted smoke is not independent acceptance; before reporting a user-facing
deliverable done, follow the independent acceptance guide: `mantle help agent-workflow-acceptance`.

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
with supplied credentials and record their results. For each declared interface, the existing handoff/README/test
report must say verified (command, identity and result), intentionally not exposed, or deferred/unverified with a
reason. WebMCP-only applications remain valid; an interrupted preview must retain the remote acceptance item
as deferred rather than silently claiming completion.
