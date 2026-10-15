# App shell

The wiring every Mantle Cloudflare app needs, ready to copy: Better Auth (email OTP, admin + user roles),
one Worker fetch (auth routes → your routes → Admin → MCP → generated REST), the Admin console assets, and a
local acceptance kit. It has no business manifests: add your own, or copy one of the examples on top of it.

## Start an app

```sh
cp -R node_modules/@aotter/mantle/docs/examples/app-shell/. my-app/   # or from this repository
cp -R node_modules/@aotter/mantle/docs/examples/club-events/. my-app/ # optional: an example on top
cd my-app
# package.json: pin the exact installed Mantle version for @aotter/mantle, -admin and -ui
pnpm install
pnpm generate          # writes generated/ and lists any `handler: { ref }` to implement in src/handlers.ts
pnpm types && pnpm check
cp .dev.vars.example .dev.vars
pnpm db:init && pnpm db:seed   # db:seed only when the example has seed.sql
pnpm dev                       # one-time codes print to this log
pnpm smoke                     # when the copied example has smoke.mjs
```

## Files you edit

| File | What it is for |
|---|---|
| `manifests/*.yaml` | Your Schemas, Views, Procedures and Triggers. `pnpm generate` compiles every file here. |
| `src/handlers.ts` | Code for each `handler: { ref }` Procedure. The Store it receives is bound to the same caller. |
| `src/routes.ts` | App-owned routes: visitor pages, SEO files, webhooks and callbacks. |
| `src/admin.ts` | Admin presentation for `--admin-extensions`: `navGroups` (sidebar groups) and `adminExtensions`. Empty by default. |
| `src/sign-in.ts` | Member sign-in page at `/sign-in` (email code, then back to `?return=`) and `signInRedirect(request)` for pages that need a signed-in visitor. Unstyled; delete it if the app has no member pages. |
| `src/schedule.ts` | Cron work. Add the cron to `wrangler.jsonc` `triggers.crons`. |
| `src/signup.ts` | `allowSignUp(env, email)`: who may create an account (allow-all by default). `auth.ts` calls it before Better Auth creates a user; `ADMIN_EMAIL` is always allowed. |
| `src/auth.ts` | Better Auth options. Two roles only: `admin` (the admin layer) and `user`. Replace the console OTP sender before deploying. |
| `smoke.mjs` | Your acceptance steps on `smoke-kit.mjs` (fresh local D1, OTP sign-in per user, REST/MCP/Admin calls). |

`src/service.ts` and `src/index.ts` rarely change. Delete the blocks marked `MCP / OAuth (optional)` in `auth.ts`
and `service.ts` if the app has no MCP.

Search for `AGENT:` to find what an app must fill in.

## Local testing notes

- Better Auth allows 3 OTP requests per minute per client IP. `smoke-kit.mjs` gives each user its own
  `cf-connecting-ip`; when testing by hand, wait a minute or vary that header.
- `ADMIN_EMAIL`'s first verified sign-in becomes `admin` while no admin exists. The sign-in response may still show
  the previous role; `/admin/api/me` shows the current one.
- Admin HTTP routes are listed in `docs/handbook/guides/native-admin.md`.
