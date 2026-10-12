# Size and startup gates

## Executable bundle regression gate

`pnpm --filter @aotter/mantle-next check:size` generates the tracked purchase
fixture, builds two real Worker fetch entries using offline
`wrangler deploy --dry-run --minify`, retaining every View/Procedure.
The PostgreSQL entry includes postgres.js; the D1 entry uses the native binding.
It excludes the seed, oracle and timing harness, rejects old compiler/runtime
and Zod sources, and measures emitted JavaScript bytes and gzip bytes against
the budgets in `size-budgets.json`. Unexpected extra deployment modules fail rather than being
omitted from totals. The normal package test command also runs this gate.
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
