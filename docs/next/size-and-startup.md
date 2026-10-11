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

## Executable bundle regression gate

`pnpm --filter @aotter/mantle-next check:size` generates the tracked purchase
fixture, builds two real Worker fetch entries using offline
`wrangler deploy --dry-run --minify`, retaining every View/Procedure.
The PG entry includes official `pg`; the D1 entry uses the native binding.
It excludes the seed, oracle and timing harness, rejects old compiler/runtime
source imports, and measures emitted JavaScript bytes and gzip bytes.
Unexpected extra deployment modules fail rather than being omitted from totals.
The normal package test command also runs this gate.

Initial measurements with Wrangler 4.137.0:

| Whole fixture Worker | Uncompressed bytes | Gzip bytes | Regression ceiling |
| --- | ---: | ---: | ---: |
| D1 | 496,630 | 103,284 | 524,288 |
| PostgreSQL | 601,733 | 133,978 | 638,976 |

These ceilings freeze current deployment output with limited headroom; they are
not a claim that the current output is minimal or equivalent to a matched native
application. Dependencies, validation code and generated SQL all count. Changes
to budgets require a reviewed explanation, not an automatic baseline refresh.
The global imports and dependency graph still need profiling, particularly
validation dependencies. A tiny hand-written contract kernel alone does not
establish a tiny deployed application.

Still required before replacement:

- Inspect the packed package file list and unpacked bytes; build-only tools may
  be large but must stay out of request imports.
- Compare matched native and generated deployment entries, including identical
  drivers and validation guarantees. Report the incremental harness cost.
- Measure selecting one operation versus the entire service as operation counts
  grow. Optional modules must not enter an unselected consumer's bundle.

## Startup is a separate gate

Cloudflare's official platform metric is `startup_time_ms`, reported after
`wrangler deploy` or `wrangler versions upload`. It measures platform startup
work, including parsing and executing global scope. A dry run does not provide
this metric. See the official [startup documentation](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
Cloud writes remain outside this task's local-only authorization.

Local Wrangler process readiness (previously about 1.7–2.1 seconds) includes CLI
and workerd bootstrap and cannot be labeled Mantle module initialization CPU.
Use fresh isolates with matched empty/native/generated entries, external
high-resolution timing and CPU profiles to investigate local startup work.
Keep A/A controls and raw samples. Local wall times remain proxies, not the
official Cloudflare metric. Workers `performance.now()` freezes between I/O
events and cannot time synchronous library initialization accurately.

Gate both startup and the first operation, then warm operations. Moving expensive
global work into a lazy first call does not meet acceptance. Set numeric CPU
budgets after the matched baseline measurement and before testing subsequent
feature slices; until that measurement exists, startup acceptance remains open.

## Interpreting the Worker PG difference

The retained current/direct-native external HTTP batch measurement has a paired
mean difference of +114.06 microseconds/read, with an exploratory bootstrap
interval of [-9.41, +246.93]. The native/native control is +43.29 with an interval
of [-155.95, +234.21]. The external clock avoids the Worker I/O clock's freezing,
but includes HTTP, scheduling, database and process effects. These measurements
do not identify a fixed framework overhead or prove performance equivalence.
The uncertainty interval is not an estimate of Wrangler's internal clock error.
Further repetitions could change the sign; do not repeat until a favorable sign
appears. Predeclare independent alternating runs, A/A controls, sample counts,
stopping rules and an acceptable equivalence margin; retain all outliers.
