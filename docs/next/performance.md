# Historical checked-slice Generated native execution: measured evidence

Measured clean source: `66122a822bf6f83151afcc69c9e420cdfdb1d922`,
2026-10-11. This is the four-target SQL slice, not full 0.2 compatibility or
proof of native performance equivalence. No cloud resources or production data
were used. All timing processes stopped before statistical analysis.

## Correctness and matching

Each actual target passed 21 grouped native semantic checks, repeated before
warm timing: complete rows/codecs, owner scope, validation, explicit OCC, atomic
rollback, UTC lowering and output validation after commit. All 48 fresh first-call
oracles passed. Native read comparisons include the same user/input boundary and
necessary scalar conversion. Warm direct-native SQL is independently authored;
an additional canonical comparator uses exactly the generated SQL.

Official PG trace verified one read each, identical canonical SQL and owner bind,
and no boot/introspection queries. SQLite/D1 generated modules and schemas are
byte-identical to `d5936122`; all four cold series below were nevertheless rerun.

## Warm full-function measurements

Bun: 600 samples per variant/target in three alternating rounds. Values are µs.

| Target | Generated p50 / p95 | Native direct p50 / p95 | Paired mean difference, exploratory 95% interval |
| --- | ---: | ---: | ---: |
| Bun SQLite | 235 / 291 | 266 / 339 | −33 [−39, −28] |
| Bun PostgreSQL | 1049 / 2569 | 1052 / 2924 | −55 [−165, +31] |

Worker `performance.now()` advances with I/O events and cannot account reliably
for post-await row processing. Its retained 2–3ms intervals are not complete
function latency and cannot prove parity.

Worker PG instead used an external high-resolution HTTP clock: 20 alternating
paired batches of 100 reads per condition, full-row oracle and common all-field
checksum. Connection/setup/end, checksum and HTTP costs are included and
amortized equally. These are batch averages, not individual-read tail percentiles.

| Worker PG comparison | A / B p50 µs per read | Paired mean difference, exploratory 95% interval |
| --- | ---: | ---: |
| Generated / native direct | 1758 / 1719 | +114 [−9, +247] |
| Before `d5936122` / generated | 1738 / 1707 | +83 [−4, +185] |
| Native / identical native control | 2095 / 1844 | +43 [−156, +234] |

For the artifact-identical D1 path, the retained `d5936122` parent-clock direct
comparison was −37µs [−147, +54]. Its identical-code control also showed drift,
so it establishes neither equivalence nor a fixed wrapper penalty.

The prior formal Bun PG series had a positive +85µs difference. It was followed
by safe generation-only scope-wrapper simplification. A same-fixture PG crossover
measured before-minus-after +14µs [−44, +56]; this does **not** establish a speedup.
Do not subtract separate formal series as a causal improvement estimate.

## Fresh first calls

Native cold uses the matched current canonical SQL. Bun has eight fresh processes
per variant; Workers have four fresh Wrangler/workerd processes per variant.
OS and DB buffers remain warm. Values below are p50 milliseconds.

| Target | Generated / native first call |
| --- | ---: |
| Bun SQLite: complete function | 4.11 / 4.20 |
| Bun PostgreSQL: complete function | 8.70 / 8.30 |
| Worker D1: complete first HTTP request | 18.54 / 17.66 |
| Worker PostgreSQL: complete first HTTP request | 42.80 / 50.60 |

Bun module import and DB setup were measured separately. Worker startup includes
module import; its first-request value includes DB setup, full-row serialization
and host JSON parsing. Local Wrangler startup is not deployed Workers cold latency.
At n8/n4, nearest-rank p95 equals the maximum and is not a stable tail estimate.

## Acceptance and reproduction

The emitted path is native calls plus boundary contracts, with no old interpreter,
custom pool, retry or lock waiter. Latest comparisons did not establish a fixed
positive warm gap, but Worker PG still has a positive estimate and broad
uncertainty. Native equivalence and a causal before/after speedup remain unproved;
the performance goal stays open. Pagination and the other 0.2 responsibilities
remain in the [compatibility ledger](compatibility.md).

Raw paired samples, artifact hashes, full percentiles and protocols are retained
in the private task lab. Public `test:native` and `bench` commands in
`packages/mantle-next` reproduce the basic native checks and warm protocol;
the extended cold/external-clock protocols remain in the task lab. Use disposable
native databases, a clean committed source,
a coordinated quiet machine and a fresh output directory. The public benchmark
records its clock limitation and provenance. Intervals use exploratory paired
hierarchical bootstrap; three rounds and small cold samples cannot guarantee
stable tails, absence of drift or performance equivalence.


## Revised native query measurements

The default query boundary has changed. Previous timings above refer to the
checked implementation, not the new bare API. New `bench` runs record separate
checked and bare samples; bare native controls use the driver's default parameter
and result behavior. Each target runs 21 checked checks and 14 independent bare
checks before timings. Do not infer a before/after speedup from different row
counts or responsibilities.

Worker acceptance additionally records parent-clock HTTP batches: four rotating
variants (generated, native with identical generated SQL, handwritten native,
identical handwritten native A/A), three rounds of thirty
batches per variant, twenty sequential reads per request, ten warmup batches per
variant. It verifies identical complete final rows for every batch. Timing includes
HTTP, final-row serialization and PG connection/search-path setup, amortized over
twenty reads; the native app owns these resources. It is not pure query CPU or a
cloud latency claim. Internal Worker timers remain I/O-event intervals only.
The exact-SQL control captures one generated driver call before measurement and
asserts its owner bind and absence of a custom type parser. SQL and its hash are
retained; generated-vs-direct differences may include SQL lowering, while the
canonical control holds SQL constant. Raw samples and artifact/harness hashes accompany each formal run. This local
acceptance protocol is outside regular CI timing gates.
