# Size and startup gates

## Executable bundle regression gate

`pnpm --filter @aotter/mantle-next check:size` generates the tracked purchase
fixture and builds two Worker fetch entries retaining every View/Procedure with
`mantle bundle`, the split build `mantle generate` configures for Wrangler. The
PostgreSQL entry includes postgres.js; the D1 entry uses the native binding. It
excludes the seed, oracle and timing harness, rejects old compiler/runtime and Zod
sources, and checks two budgets per target in `size-budgets.json`: `startup` (the
entry and its static imports, what a cold isolate evaluates) and `total` (every
uploaded chunk, operations included). It also builds a collection-only entry, whose
startup contains no operation SQL, and a direct View entry, which stays below 4 KiB.
The normal package test command runs this gate.

`check:package` enforces the published file allowlist and the size ceilings in
`scripts/check-package.ts`.

## Startup

Cloudflare's official `startup_time_ms`, reported after deployment/version upload,
measures platform parsing and global execution. Offline dry runs do not supply it,
and cloud writes remain outside local-only authorization. See the official
[startup documentation](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
Workers `performance.now()` freezes between I/O events and cannot time synchronous
initialization; gate global startup, first use and warm calls separately.
Startup CPU acceptance is open (see the [compatibility gates](compatibility.md#gates-before-expanding-claims)).
