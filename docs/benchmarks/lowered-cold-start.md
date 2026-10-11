# Generate-time lowering: cold-start measurements

Issue #1433, [ADR-0044](../adr/0044-generate-time-lowering.md). Reproduce with
`scripts/bench-cold-start.mjs`; it is not part of `pnpm check`.

## Protocol

Each run is a fresh `node` process, the closest local stand-in for a new
isolate. It boots the plan on a copy of a converged SQLite file (`node:sqlite`)
and times, for every call, the first and the second execution: wall time, the
driver's own SQL time, and Mantle CPU = wall minus SQL. Two variants alternate
run by run:

- **lowered**: the plan as `mantle generate` wrote it, with `plan.lowered`;
- **compile cache**: the same plan with `lowered` deleted and the fingerprint
  recomputed, which is the 0.2.0-alpha.6 path in the same build.

```sh
pnpm --filter @aotter/mantle build
node scripts/bench-cold-start.mjs \
  --plan docs/examples/reference-service/.mantle/generated/plan.json \
  --caller o1:owner --seed seed.json --runs 30 \
  --calls 'view:catalog,view:search-items:{"q":"apple"},view:my-orders,view:sales-by-item,view:recent-activity,proc:restock:{"sku":"A1","name":"apple","qty":2}'
```

`seed.json` is three `store.write` inserts into `items`. The calls run in this
order in one process, so a later call's first execution benefits from the code
an earlier one already warmed: the first call carries V8's first execution of
the shared machinery, which no design removes.

## Result: the reference service, 30 fresh processes per variant

Node v22.22.0, a 4-CPU machine shared with another job (so absolute numbers are
noisy; the variants alternate to share that noise). Mantle CPU in milliseconds.

| call | execution | lowered median | lowered p95 | compile cache median | compile cache p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| view:catalog | first | 2.2 | 4.4 | 10.4 | 13.7 |
| view:catalog | second | 0.1 | 0.3 | 0.2 | 0.4 |
| view:search-items | first | 8.6 | 14.8 | 16.4 | 24.3 |
| view:search-items | second | 0.2 | 0.5 | 0.2 | 0.4 |
| view:my-orders | first | 0.2 | 0.2 | 3.8 | 5.9 |
| view:my-orders | second | 0.1 | 0.1 | 0.1 | 0.2 |
| view:sales-by-item | first | 0.2 | 0.3 | 4.7 | 11.1 |
| view:sales-by-item | second | 0.4 | 0.9 | 0.4 | 0.6 |
| view:recent-activity | first | 0.3 | 0.5 | 2.0 | 6.4 |
| view:recent-activity | second | 0.1 | 0.2 | 0.2 | 0.3 |
| proc:restock | first | 5.8 | 11.1 | 8.3 | 14.2 |
| proc:restock | second | 0.3 | 0.5 | 0.4 | 0.6 |

| | lowered | compile cache |
| --- | ---: | ---: |
| `plan.json` bytes | 33 064 | 15 535 (lowered is +113%) |
| boot ms, median / p95 | 17.0 / 26.6 | 13.7 / 20.1 |
| `planFingerprint` ms, cold, median | 10.4 | 8.2 |
| sum of the six first-call medians | 17.3 | 45.6 |

`bootReport().lowered` was `used` in every lowered run and `absent` in every
compile-cache run.

## Reading it

- The first call of a sealed View or inline Procedure drops by its compile
  share: `catalog` 10.4 to 2.2 ms, `my-orders` 3.8 to 0.2, `sales-by-item` 4.7
  to 0.2. The counters in `test/core/lowered-cold.test.ts` assert that those
  first calls make zero dialect checks, zero `applyPolicy` calls and zero prints.
- What remains in the first call is mostly not compilation: `search-items`
  (8.6 ms) and `restock` (5.8 ms) take input, so they also build their input and
  output JSON Schema validators on first use (`jsonSchemaToZod`, a separate
  change: ADR-0044 decision 7), and `catalog`'s 2.2 ms includes V8's first
  execution of Core's request path. These were not profiled separately here.
- Boot costs 3 to 4 ms more: seeding plus hashing a plan twice its size
  (`planFingerprint` 8.2 to 10.4 ms). It is paid once per isolate, before the
  first request, and is the next candidate for moving off the request path.
- Warm second calls do not change beyond noise; they already hit the compile
  cache.

## Not measured here

- Swolhalla's real-data snapshot (`checkin-wall`, `training-report`, and the
  other routes) and its relative targets: a maintainer-run follow-up with this
  script.
- PostgreSQL: no database was available, so the PostgreSQL statements are
  covered by the parity test (every printer-corpus program emits identical SQL
  and binds with and without lowering, and `dialect.print` equals the executor's
  text) and not by an execution benchmark.
- The installed 0.2.0-alpha.6 package as a third variant.
