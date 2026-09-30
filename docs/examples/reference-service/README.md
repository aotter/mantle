# Reference service

A small shop built on `@aotter/mantle` 0.2.0. It is also the Worker that the
release gate runs (`scripts/check-worker-consumer.mjs`).

- `manifests/`: the whole service in the v2 grammar.
  - A scoped Schema (`orders`) and a Schema with a check (`items`, `stock >= 0`).
  - Views written as one `SELECT`: a join, a `GROUP BY`, and `mantle.search`.
  - Procedures written as SQL: a two-statement order, an `ON CONFLICT`
    restock, and an optimistic-lock cancel in handler code.
  - An after hook that loops over `ctx.cause.rows`.
  - A POSIX cron.
- `src/handlers.ts`: the three `ref` handlers, written against the typed
  `ctx.store`.
- `src/service.ts`, `src/index.ts`, `wrangler.jsonc`, `tsconfig.json`: the
  preset `mantle generate` wrote once. These files are the application's own.
- `smoke.mjs`: starts `wrangler dev` on a fresh local D1 and drives the service:
  - console email-OTP sign-in for an owner and a buyer;
  - REST, both MCP surfaces, Admin's API and the cron;
  - asserts scope, the stock check, locks and hooks.

Outside the SDK workspace, with Node 22+ and pnpm 9+, pin every dependency to
one exact version, then:

```sh
pnpm install
pnpm check                      # generate, generate --check, typecheck, smoke
cp .dev.vars.example .dev.vars  # set ADMIN_EMAIL and a random BETTER_AUTH_SECRET
pnpm dev                        # sign-in codes are printed to this log
```

The `latest` specifiers in `package.json` are placeholders. The release gate
installs the exact tarballs it just packed in their place.
