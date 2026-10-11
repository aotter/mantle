# Size, startup and compatibility gates

The recommended migration is to complete Next by observable contract slices,
then replace the existing package once the compatibility ledger and real
consumers pass. Do not attach the old executor to the new generated functions.
The existing package is a functional reference, not a requirement to reproduce
its internal ownership or bugs. Any intentional behavior change needs an explicit
decision and a contract test. Refused and open ledger entries block replacement.

For each slice, map the existing specification and relevant tests to new tests
on all four targets. Check results, persisted state, authorization, failure
envelopes, hook ordering, OCC and rollback as applicable. Typecheck actual
consumers and optional surfaces. Match native contracts and driver work before
comparing performance; fewer guarantees is not a valid faster implementation.
The SQL slice alone cannot establish full 0.2 compatibility.

## Bare query (2026-10-11)

| Full fixture Worker | Bytes | Gzip | Ceiling |
| --- | ---: | ---: | ---: |
| D1 | 16,120 | 2,552 | 20,480 |
| PostgreSQL, official driver included | 111,844 | 32,481 | 122,880 |

The size gate now rejects any Zod in the bundle. The npm package unpacks to
66,195 bytes.

## Executable bundle regression gate

`pnpm --filter @aotter/mantle-next check:size` generates the tracked purchase
fixture, builds two real Worker fetch entries using offline
`wrangler deploy --dry-run --minify`, retaining every View/Procedure.
The PG entry includes official `pg`; the D1 entry uses the native binding.
It excludes the seed, oracle and timing harness, rejects old compiler/runtime
and Zod sources, and measures emitted JavaScript bytes and gzip bytes against
`size-budgets.json`. Unexpected extra deployment modules fail rather than being
omitted from totals. The normal package test command also runs this gate.
`check:package` enforces the published file allowlist and size ceilings.

## Startup

Cloudflare's official `startup_time_ms`, reported after deployment/version upload,
measures platform parsing and global execution. Offline dry runs do not supply it,
and cloud writes remain outside local-only authorization. See the official
[startup documentation](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
Workers `performance.now()` freezes between I/O events and cannot time synchronous
initialization; gate global startup, first use and warm calls separately.
Startup CPU acceptance is open.
