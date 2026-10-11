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

## Measured footprint baseline

With Wrangler 4.137.0, source `771cc141` passes these complete fixture gates:

| Whole fixture Worker | Before, bytes | After, bytes | Gzip after | Ceiling |
| --- | ---: | ---: | ---: | ---: |
| D1 | 496,630 | 126,011 | 33,473 | 139,264 |
| PostgreSQL | 601,733 | 231,031 | 63,992 | 245,760 |

The dominant cause was `import { z } from "zod"`: esbuild retained all locale
modules. Generated code now uses `import * as z from "zod"`, retaining the same
official validators with only English error messages bundled. Metafiles reject
unused locales and old Mantle compiler/executor sources. This removes roughly
362 KiB per Worker. The remaining full D1 bundle includes approximately 96 KiB
of Zod, 23 KiB of generated operations and 4 KiB of contract primitives.
PostgreSQL additionally includes the official driver and its dependencies.

Consumers selecting a single operation should import its generated direct entry
(`views/<encoded-name>.ts` or `procedures/<encoded-name>.ts`). The existing maps
remain available but retain their other properties when bundled. Direct entries
use stable operation-name aliases: stale entries for removed operations fail
module import instead of silently binding another operation after regeneration.

`baseline:footprint` retains sources, bundle hashes and official metafiles for
controlled variants. Its health/contract probe adds a small wrapper, so these
sizes differ from the complete fixture gate above:

| Instrumented entry | D1 bytes | PG bytes |
| --- | ---: | ---: |
| Single View through full map | 81,932 | 176,047 |
| Single View through direct entry | 75,927 | 171,012 |
| Native selected View | 73,163 | 167,525 |
| Selected map with 100 Views | 160,403 | 250,267 |
| Direct entry with 100 Views | 75,923 | 171,008 |

The native control independently implements the same aggregate SQL, ownership
filter, strict empty-input validator and valid output. It does not implement the
complete Mantle failure envelope or JSON limits: this is a scoped fixture
comparison, not full application contract equivalence. Direct-entry excess is
2,764 bytes for D1 and 3,487 for PG. Gates cap this excess at 4 KiB, total selected
bundles at 80/176 KiB, and growth with 100 Views at 128 bytes. All passed.

The actual `pnpm pack` baseline was 63,171 bytes packed / 238,185 unpacked,
including tests, scripts and source. A `files` allowlist now ships compiled
artifacts, README, package metadata and LICENSE. At `771cc141` it is 31,136 bytes
packed / 115,738 unpacked, 31 files. `check:package` enforces the file allowlist
and ceilings of 40/128 KiB. These numbers exclude installed dependencies;
Worker bundle gates include request dependencies. This is packaging hygiene,
not publication readiness: the experimental generator still imports the existing
compiler through workspace-relative paths. A standalone packed generator remains
an open requirement before publishing.

Reproduce with a fresh output directory (no cloud writes):

```sh
MANTLE_NEXT_FOOTPRINT_OUTPUT=/tmp/next-footprint pnpm --filter @aotter/mantle-next baseline:footprint
python3 packages/mantle-next/scripts/baseline-startup.py /absolute/path/to/installed/workerd /tmp/next-footprint
```

## Local cold baseline: D1 watchdog failed

The `771cc141` run retained 168 fresh workerd process samples: two targets,
seven variants, twelve rotating rounds each. Compatibility date is 2026-09-28
with `nodejs_compat`. Native A/A uses identical bundle hashes. Each process is
waited before measuring child CPU; occupied probe ports fail preflight.

| Entry (p50, n=12) | D1 process CPU ms | PG process CPU ms | D1 first contract HTTP ms | PG first contract HTTP ms |
| --- | ---: | ---: | ---: | ---: |
| Whole before import fix | 55.32 | 68.99 | 3.36 | 3.07 |
| Whole after import fix | 51.76 | 52.65 | 3.48 | 4.03 |
| Selected direct | 43.70 | 48.24 | 3.16 | 2.88 |
| Native selected | 32.43 | 53.12 | 2.94 | 2.95 |
| Identical native A/A | 34.83 | 48.95 | 2.96 | 2.88 |
| Direct with 100 Views | 38.78 | 50.50 | 3.23 | 3.02 |

Process CPU includes workerd startup, health probe, two fake-DB contract calls,
shutdown and Perfetto tracing, across all threads. First-contract timing uses an
external HTTP clock and includes initial lazy validator construction, validation
and projection; it performs no actual database query or connection. These are
local diagnostic signals, not pure library initialization CPU or database latency.
Driver-only entries receive health requests and are not equal-work CPU controls.

The predeclared operational watchdog compares direct process CPU to
`native * 1.10 + max(5ms, 2 * abs(nativeA - nativeB))`, where native is the mean
of the two native medians. D1's ceiling is 42.00ms and its 43.70ms observation
fails. The PG observation is below its analogous ceiling, but the script exits
on the D1 failure. Results are written before assertions. No samples were
removed and no repeat run was used to seek a passing result. This heuristic is
not a statistical equivalence test. Native cold acceptance remains open.

Initial module/global slices were absent from the collected fast-start traces;
absence does not mean zero CPU. Thus the failing difference cannot yet be
attributed to module initialization or contract code. Separate startup profiling
and an unprofiled timing protocol are still needed for attribution.

Cloudflare's official `startup_time_ms`, reported after deployment/version upload,
measures platform parsing and global execution. Offline dry runs do not supply
it, and cloud writes remain outside local-only authorization. See the official
[startup documentation](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time).
Wrangler CLI readiness includes CLI/bootstrap work. Workers `performance.now()`
freezes between I/O events and cannot accurately time synchronous initialization.
Gate global startup, first use and warm calls separately; moving expensive work
to the first call does not establish acceptance.

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
