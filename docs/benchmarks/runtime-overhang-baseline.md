# Runtime overhang baseline: develop ba247760

Local evidence, not a production claim. These are Node 22 processes over a local SQLite file (`node:sqlite`): no Cloudflare
Workers isolate, no D1 round trip, no PostgreSQL, no bundled build. SQL is nearly free here, so the *ratios* look worse than
they would against D1; read the absolute overhang in µs and ms. This is the "before" for #1432 (Schema readers replace
`Store.select`) and #1433 (generate-time lowering); refs #1434. No ADR: it is contributor tooling and evidence.

It was produced by the harness in `packages/mantle/bench/` (methodology, options and caveats in its README) on develop at
`ba247760` with only the harness added (no change under `packages/mantle/src`):

```bash
pnpm build
pnpm bench --label develop-ba247760 --json docs/benchmarks/data/runtime-overhang-ba247760.json
```

Raw numbers: [`data/runtime-overhang-ba247760.json`](data/runtime-overhang-ba247760.json) (schema `mantle-bench/1`; timings and
counts only, no rows). To compare a change against it, run the same command in the PR checkout on the same machine and
`pnpm bench:compare data/runtime-overhang-ba247760.json <pr>.json`.

## Environment

| field | value |
|---|---|
| variant | develop-ba247760 (@aotter/mantle 0.2.0-alpha.6, git ba247760) |
| app | training (40 exercises, 824 workouts, 22,720 sets) |
| dialect | sqlite via node:sqlite (a local file database; reads are nearly free compared with D1 over RPC) |
| node | v22.22.0 on linux x64 |
| cpu | Intel(R) Xeon(R) Processor @ 2.10GHz x4 |
| mode | all; warm: 3 rounds x up to 200 samples (warmup 20, 5000 ms budget per item per round); cold: 10 fresh processes per item per side (+1 discarded); counters on |
| date | 2026-10-10T15:18:45.983Z |

The fixture is Swolhalla-shaped: one member over 3 years (624 workouts, 18,720 sets) plus four noise owners, six Views, two
ref-handler Procedures that combine several Views, one inline write and one `Store.select` item. The machine was shared with
another process during the run (4 CPUs), so absolute numbers carry noise; compare variants run back to back, not across days.

## Results

### Warm

Overhang is the median over sample pairs of (Mantle wall - native replay of the exact SQL and binds Mantle sent). Counters are compile/check/policy/paged/print/zod/storeIr per warm call.

| item | kind | n | stmts | native p50 µs | mantle p50 µs | overhang p50 µs | ratio | mantle p95 µs | mantle CPU p50 µs | cpu/call µs m/n | warm counters |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| view:workout-list:first | view | 600 | 1 | 254 | 453 | 152 | 1.8 | 632 | 166 | 493/355 | 0/0/0/0/0/0/0 |
| view:workout-list:page-5 | view | 600 | 1 | 1,364 | 1,582 | 235 | 1.2 | 2,616 | 203 | 1,844/1,628 | 0/0/0/0/0/0/0 |
| view:workout-sets | view | 600 | 1 | 187 | 324 | 139 | 1.7 | 543 | 133 | 418/228 | 0/0/0/0/0/0/0 |
| view:personal-records | view | 600 | 1 | 4,451 | 4,590 | 175 | 1.0 | 7,998 | 135 | 5,294/5,034 | 0/0/0/0/0/0/0 |
| view:exercise-history | view | 600 | 1 | 656 | 994 | 346 | 1.5 | 1,627 | 313 | 1,207/775 | 0/0/0/0/0/0/0 |
| view:weekly-volume | view | 60 | 1 | 39,257 | 39,657 | 209 | 1.0 | 64,301 | 244 | 44,174/45,067 | 0/0/0/0/0/0/0 |
| view:weekly-volume:all-pages | view | 43 | 4 | 158,233 | 160,546 | 1,138 | 1.0 | 240,667 | 969 | 170,899/163,187 | 0/0/0/0/0/0/0 |
| view:training-summary | view | 600 | 1 | 907 | 1,137 | 220 | 1.3 | 1,875 | 194 | 1,294/1,063 | 0/0/0/0/0/0/0 |
| procedure:training-report | procedure-ref | 120 | 5 | 51,645 | 53,838 | 780 | 1.0 | 76,546 | 1,219 | 55,494/51,590 | 0/0/0/0/0/0/0 |
| procedure:checkin-wall | procedure-ref | 600 | 4 | 5,272 | 6,781 | 1,468 | 1.3 | 11,327 | 1,280 | 8,199/6,541 | 1/1/1/1/1/0/1 |
| procedure:set-duration | procedure-inline | 600 | 2 | 1,224 | 1,376 | 112 | 1.1 | 4,033 | 118 | 606/483 | 0/0/0/0/0/0/0 |
| select:sets-by-workout | select | 600 | 1 | 142 | 1,053 | 920 | 7.4 | 3,195 | 827 | 1,600/213 | 1/1/1/1/1/0/1 |

### Cold

Each sample is a fresh Node process on an already converged database. Cold overhang = Mantle first call - native first call; imports, plan parse and boot are reported separately.

| item | n | import core+dialect ms | plan ms | boot ms | first ms | first SQL ms | first Mantle CPU ms | native first ms | cold overhang ms | 2nd ms | first-call counters |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| view:workout-list:first | 10 | 154.8 | 0.6 | 9.5 | 13.9 | 0.4 | 13.4 | 1.00 | 12.9 | 0.7 | 1/1/1/1/1/0/0 |
| view:workout-list:page-5 | 10 | 160.1 | 0.8 | 8.2 | 19.7 | 2.0 | 17.2 | 2.64 | 17.1 | 2.0 | 1/1/1/1/1/0/0 |
| view:workout-sets | 10 | 135.2 | 0.6 | 8.4 | 21.5 | 0.4 | 21.1 | 0.88 | 20.6 | 0.7 | 1/1/1/1/1/1/0 |
| view:personal-records | 10 | 170.6 | 0.9 | 10.1 | 24.7 | 8.7 | 16.0 | 8.24 | 16.5 | 7.9 | 1/1/1/1/1/0/0 |
| view:exercise-history | 10 | 138.7 | 0.7 | 8.1 | 20.3 | 1.0 | 19.2 | 1.93 | 18.3 | 1.4 | 1/1/1/1/1/1/0 |
| view:weekly-volume | 4 | 134.7 | 0.6 | 7.3 | 56.5 | 43.7 | 12.5 | 46.68 | 9.8 | 41.3 | 1/1/1/1/1/0/0 |
| view:weekly-volume:all-pages | 3 | 153.3 | 0.6 | 8.2 | 196.3 | 180.1 | 16.2 | 197.45 | -1.2 | 177.7 | 1/1/1/2/2/0/0 |
| view:training-summary | 10 | 156.9 | 0.6 | 9.2 | 28.2 | 1.2 | 27.0 | 2.29 | 25.9 | 1.8 | 1/1/1/1/1/1/0 |
| procedure:training-report | 4 | 146.8 | 0.6 | 7.7 | 93.3 | 50.2 | 42.8 | 60.46 | 32.9 | 52.8 | 5/5/5/5/5/4/0 |
| procedure:checkin-wall | 10 | 165.1 | 0.7 | 9.5 | 44.9 | 10.2 | 33.4 | 9.50 | 35.4 | 11.8 | 4/4/4/4/4/3/1 |
| procedure:set-duration | 10 | 149.9 | 0.8 | 8.8 | 18.2 | 2.1 | 16.1 | 2.92 | 15.3 | 2.0 | 1/1/1/0/1/2/0 |
| select:sets-by-workout | 10 | 165.2 | 0.8 | 9.6 | 10.8 | 0.3 | 10.4 | 0.76 | 10.0 | 2.0 | 1/1/1/1/1/0/1 |

### Counters by phase

compile/check/policy/paged/print/zod/storeIr, from V8 precise coverage in separate processes.

| item | boot | first call | second call | warm call |
|---|---|---:|---:|---:|
| view:workout-list:first | 0/0/0/0/0/0/0 | 1/1/1/1/1/0/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:workout-list:page-5 | 0/0/0/0/0/0/0 | 1/1/1/1/1/0/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:workout-sets | 0/0/0/0/0/0/0 | 1/1/1/1/1/1/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:personal-records | 0/0/0/0/0/0/0 | 1/1/1/1/1/0/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:exercise-history | 0/0/0/0/0/0/0 | 1/1/1/1/1/1/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:weekly-volume | 0/0/0/0/0/0/0 | 1/1/1/1/1/0/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:weekly-volume:all-pages | 0/0/0/0/0/0/0 | 1/1/1/2/2/0/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| view:training-summary | 0/0/0/0/0/0/0 | 1/1/1/1/1/1/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| procedure:training-report | 0/0/0/0/0/0/0 | 5/5/5/5/5/4/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| procedure:checkin-wall | 0/0/0/0/0/0/0 | 4/4/4/4/4/3/1 | 1/1/1/1/1/0/1 | 1/1/1/1/1/0/1 |
| procedure:set-duration | 0/0/0/0/0/0/0 | 1/1/1/0/1/2/0 | 0/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| select:sets-by-workout | 0/0/0/0/0/0/0 | 1/1/1/1/1/0/1 | 1/1/1/1/1/0/1 | 1/1/1/1/1/0/1 |

## What it shows

- **Warm Views and inline Procedures are already at zero counters.** Every View and `procedure:set-duration` shows
  `0/0/0/0/0/0/0` on a warm call: compile, check, policy, paged wrap, print and zod all hit their caches. Their warm
  overhang is about 0.1 to 0.35 ms per call (0.14 ms for `workout-sets` over a 0.19 ms native read); it grows only with
  more statements (`training-report` sends 5 statements: about 0.8 ms over 52 ms of SQL).
- **`Store.select` misses every cache.** `select:sets-by-workout` has `1/1/1/1/1/0/1` on every call (compile, check, policy,
  paged wrap, print and `StoreJson.select`): 0.92 ms over a 0.14 ms read, ratio 7.4, where a View over a similar read adds 0.14 ms.
  `procedure:checkin-wall`, whose handler makes one `Store.select`, carries that cost (1.5 ms overhang) with the same
  non-zero warm counters. This is what #1432 removes.
- **The cold first call pays for everything the warm path cached.** Each View's first call runs compile, check, policy and
  print once (and zod once when it has input), which is 10 to 27 ms of Mantle CPU for a call whose SQL mostly takes 0.4 to 9 ms;
  `training-report` (five Views) spends 43 ms. The second call is back to the warm figure. This is what #1433 removes.
- **Imports dominate a cold start in Node**: about 135 to 170 ms to import `@aotter/mantle` and `/d1` unbundled, against 7 to
  10 ms to boot a converged database and under 1 ms to parse the plan. Unbundled Node ESM import is not what a Worker pays,
  so do not read that figure as an isolate start (see the harness README).
- `weekly-volume` and its all-pages walk are slow in the SQL itself (39 and 158 ms native): `date_trunc('week')` and a grouped
  paged View on SQLite (#1291). Their overhang is small next to that; they run fewer samples (`n` column).
- `view:weekly-volume:all-pages` shows a negative cold overhang (-1.2 ms): with 3 samples and 180 ms of SQL the Mantle and
  native first calls are within noise of each other.

## Fixture notes

The `training-summary` View keeps its CTE + window + join shape, but its `ranked` CTE also outputs `id`
(`v.exercise AS id`): a paged View ordering by a CTE needs the CTE to output `id`, and the first spelling was refused with
"ordering r, a CTE, needs the CTE to output id". Both dialects compile all six Views.

Warn-only timing thresholds in `bench/fixtures/training/mantle.bench.mjs` come from this run: the largest warm overhang was
1.5 ms and the largest cold overhang 35 ms, so the limits are 5 ms and 300 ms (never tighter than ratio 5). Counter,
row-floor and parity checks are exact and fail; all 130 checks of this run passed.

## Not measured

PostgreSQL, Cloudflare Workers/D1/workerd, Bun (`bun:sqlite`), a bundled cold variant, and interleaved A/B inside one
run. They are deferred follow-ups; the harness README lists them.
