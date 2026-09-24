---
description: "Open local Admin in one shot: follow the official OTP example, bind ASSETS, sign in with email OTP from wrangler logs, land in the Dev UI."
---
# Quickstart: local Admin

New generated CF and Sites apps include Admin by default. To leave it out,
select smaller features explicitly. This tutorial shows the existing
direct-authored Worker integration with local email OTP; use it when you own
the Worker entry. [Project layout and CLI](./project-and-cli.md) describes the
new generated path.

The procedural source of truth is the official example:

**[`docs/examples/host-local-admin-otp/README.md`](../../examples/host-local-admin-otp/README.md)**

Copy that directory outside the SDK checkout (or author the same files from
it). Interview the human for one value before writing files: the bootstrap
owner email. The example uses `owner@example.com`. Then:

```sh
pnpm install && pnpm generate && pnpm dev
```

Open the wrangler Ready-on URL (`http://127.0.0.1:8787/admin/sign-in`), submit
the owner email, and read the OTP from wrangler logs. `mantle generate` syncs
the prebuilt Admin SPA; do not Vite-build Admin.

Traps (documented on the example):

- Prefer `127.0.0.1` over `localhost` (`INVALID_ORIGIN`).
- `pnpm check` / smoke rewrites `.dev.vars` to a smoke-only port — restore it
  from `.dev.vars.example` before `pnpm dev`.

Pin every selected `@aotter/mantle*` package to the same exact version; see
[Versions](../reference/surface.md#versions). Admin needs both
`@aotter/mantle-admin` and `@aotter/mantle-admin-ui`, wrangler `ASSETS` on
`./public`, and `createAuth` email-otp + `ConsoleEmailSender`.

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
