# Local Admin OTP

This is the opt-in Dev UI path: a directly authored Cloudflare application
that opens Mantle Admin locally with email OTP. Admin is not required to
ship a complete service. It is not a Starter or CLI generator. The notes
Schema is example business data; `mantle generate` never invents it.

Spec + adapter without Admin:
[`docs/examples/minimal-worker`](../minimal-worker/README.md).

Pin every `@aotter/mantle*` package to the exact version in this snapshot
(`packages/mantle/package.json`). This reference records that version as
its published baseline; Core's test runner substitutes its exact candidate
in a disposable copy.

## One-shot

Outside the SDK workspace, with Node 22+ and pnpm 9+:

```sh
pnpm install && pnpm generate && pnpm dev
```

`predev` copies `.dev.vars.example` to `.dev.vars` when that file is
missing. `PUBLIC_ORIGIN` must match the origin wrangler prints (the
example uses `http://127.0.0.1:8787`). Then:

1. Open `http://127.0.0.1:8787/admin/sign-in`.
2. Sign in with the bootstrap owner email from `.dev.vars` (`owner@example.com`
   in the example).
3. Read the one-time code from the wrangler log line
   `[ConsoleEmailSender] auth.email-otp.sign-in → …`.
4. Land in the Admin / Dev UI as `owner`.

`mantle generate` syncs the prebuilt Admin SPA from `@aotter/mantle-admin-ui`
into `public/_mantle/admin/`. There is no Vite or frontend build step unless
you are developing `admin-ui` itself.

## Hard requirements for Admin

Admin is not a Worker route that paints itself. These must all be present:

| Piece | Why |
|---|---|
| `@aotter/mantle-admin` and `@aotter/mantle-admin-ui` | Admin API plus the prebuilt SPA |
| `assets.directory = ./public` and `binding = ASSETS` | Serves `/_mantle/admin/assets/*` |
| `createAuth` `email-otp` + `ConsoleEmailSender` | Local human sign-in; code is in wrangler logs |
| `bootstrapOwner.match: email` | First matching sign-in becomes `owner` |
| `PUBLIC_ORIGIN` and `BETTER_AUTH_SECRET` | Auth construction; copied from `.dev.vars.example` |

If `/admin` returns HTML `200` while `/_mantle/admin/assets/*` is `404`, the
SPA white-screens. That is a missing or misconfigured `ASSETS` binding, not a
failed frontend build. Do not put `/_mantle` in `run_worker_first`; asset
paths must fall through to Static Assets.

`ConsoleEmailSender` is the local path only. Do not wire it in production.

## What this project does not do

`/` is `404`: no visitor frontend is installed. Public GET
`/api/views/published-notes` still works against fresh local D1. Conventional
GitHub Auth (`MANTLE_AUTH_MODE`) is not used; the Worker replaces construction
with `createAuth` while Core still owns `/admin` and `/api/auth/*`.

Commit the resolved lockfile in a real application and use frozen installs
afterwards. Configure a real D1 `database_id`, a production email sender, and
secrets before any remote deploy. Never commit `.dev.vars`.
