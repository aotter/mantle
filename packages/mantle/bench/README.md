# Runtime overhang benchmark

Contributor tooling, not shipped (`files` in package.json is `dist` and `docs`). It measures how much a Mantle call
costs on top of the SQL it sends, so that work such as #1432 (Schema readers) and #1433 (generate-time lowering) can
show before and after numbers on one machine. No ADR: it changes no runtime behaviour, grammar, plan format or trust
boundary.

For every View, Procedure and Store read of an app it reports:

- **Warm**: per-call Mantle wall time, CPU, and a **native baseline** that replays the exact SQL and binds Mantle sent
  through the same driver. Overhang is `Mantle - native`, taken per sample pair.
- **Cold**: a fresh Node process per sample: import, plan parse, runtime boot, then the first, second and third call, next
  to a fresh process that only opens the database and replays the recorded SQL.
- **Counters**: exact call counts of `compileProgram`, `validateIr`, `applyPolicy`, `pagedOf`, `print`, `jsonSchemaToZod`
  and `StoreJson.select` for the boot, first, second and a warm call. They come from V8 precise coverage
  (`node:inspector`), so production code is never instrumented.

## Run it

```bash
pnpm install --frozen-lockfile
pnpm build                       # the harness runs the built dist, exactly as production does
pnpm bench                       # all: cold + warm + counters, writes JSON under bench/results/
pnpm bench:cold                  # cold and counters only
pnpm bench:warm                  # warm and counters only
pnpm bench:check                 # small run with pass/fail rules (see Checks)
pnpm bench:check --items view:workout-sets
pnpm bench:compare base.json head.json [--out cmp.md]
```

Root scripts forward their arguments, so options go straight after the script name (no `--`; a literal `--` would make
the harness read the options as positionals). The same scripts exist in `packages/mantle`.

| option | meaning |
|---|---|
| `--app <path>` | a dir containing `mantle.bench.mjs`, or the module itself. Default: `bench/fixtures/training` |
| `--mantle <dir>` | the `@aotter/mantle` package dir to measure. Default: this package for the fixture |
| `--label <name>` | variant label, default `<version>@<git sha>` |
| `--items a,b*` | substring or `*` glob on item names; matching nothing exits 2 |
| `--rounds --samples --warmup` | warm settings (`all` 3/200/20, `check` 1/50/10); an item's own `samples` and `warmup` cap them |
| `--time-budget-ms` | per item per round; sampling stops after it once 10 samples exist (default 5000, `check` 3000) |
| `--cold-samples` | fresh processes per item per side, plus one discarded (`all` 10, `check` 3; an item may lower it) |
| `--no-counters` | skip the coverage processes |
| `--json <file>` / `--out <file.md>` | result file (default `bench/results/<timestamp>-<label>.json`) / also write the markdown |
| `--seed-reset` | rebuild the cached database |
| `--strict-timing` | timing violations fail instead of warning |

The default `pnpm bench` finishes in a few minutes on a 4-CPU machine. The number of samples behind each warm row is
printed in its `n` column, because the slow items (`weekly-volume`, `all-pages`) run fewer.

## How it measures

**Preparation.** For the fixture, the harness copies `manifests/` into `<tmpdir>/mantle-bench-cache/project-*/` (set `MANTLE_BENCH_CACHE` to move it; it stays outside the repository because the scratch projects carry a `package.json`), links
`node_modules/@aotter/mantle` to the package under test and runs the real `mantle generate` (`--identity none --features
web --host none --dialect sqlite`; a `warning:` on stderr is a failure), as `scripts/check-doc-examples.mjs` does. So
whatever `generate` lowers or precomputes is measured without a harness change. The database is seeded once through the
real storage convergence and cached by variant, plan fingerprint and seed version, so cold boots take the converged path a
deployed service takes.

**Record.** One process boots the runtime and calls each item once with the driver recording every call. Those recorded
statements and binds (bigint, bytes and dates are tagged for JSON) are what the native side replays. They stay in
the cache directory; result files hold only timings and counts, never rows or SQL.

**Warm.** One process, one runtime. Per round the item order is a seeded shuffle (reversed on odd rounds) with `gc()`
between items. Each sample pairs one Mantle call with a replay of exactly the statements that call sent, ABAB then BABA,
both through the same timed driver wrapper so the wrapper's cost lands on both sides. Reported: the median of round
medians (min-max across rounds in the JSON), p95, the p50 of per-pair overhang, ratio, Mantle CPU (`wall - time inside the
driver`) and `process.cpuUsage()` per call.

**Cold.** Each sample is its own process. Samples shuffle the item order with a fixed seed and alternate which side runs
first; the first sample of each item is discarded. Cold overhang is the median Mantle first call minus the median native
first call. A cold process does one item, so "first call" means the first call of every statement in a fresh runtime.

**Counters.** Run in separate processes, never in timing runs, because coverage disables some V8 optimisations. Coverage
starts before Mantle is imported (it refuses if a script of the package is already loaded). `warm` is the fifth call.
The target table is `bench/lib/counters.mjs`, the one place to edit if a change renames or moves one of those functions.
Statuses: `ok`; `not-loaded` (the file was never loaded, count 0); `missing` (the file is loaded and its source no longer
defines the function). The `validateIr` count is the dialect file only: the d1 validator delegates to the core allowlist,
which would count each check twice.

## Reading the output

- `stmts` is the number of SQL statements one call sends.
- `ratio` is Mantle p50 over native p50. On local SQLite the SQL is nearly free, so ratios look far worse than they would
  against D1 over RPC where the round trip dominates; read the absolute overhang in µs.
- `cpu/call µs m/n` is process CPU per call for Mantle and for the replay.
- Warm counters `c/k/p/pg/pr/z/s` are compile/check/policy/paged/print/zod/storeIr. A warm View or inline Procedure should be
  all zero; `select:sets-by-workout` (Store.select) is not, because `StoreJson.select` builds fresh IR on every call.
- `boot` includes `planFingerprint` hashing of the whole plan (done on every boot) and the convergence reads; do not
  attribute it to SQL or policy.
- `first Mantle CPU` is first call minus the time spent inside the driver.

## Checks (`bench:check`)

Failures: an item threw; `rows < minRows`; a native replay returned a different row count per statement than Mantle's
driver call (parity); a counter in the item's `zeroWarm` is non-zero on the warm call, or in its `zeroFirst` on the first
call; a counter target with status `missing` that the item names (otherwise only a warning).

Warnings (failures with `--strict-timing`): warm overhang above `max(overheadUsMax, overheadRatioMax x native p50)`, or cold
overhang above `firstCallOverheadMsMax`, from the app's `thresholds`. Timing on a shared machine is noisy; do not tighten
thresholds without `--strict-timing` evidence from a quiet one.

There is no CI step yet: the gate lands after #1432 and #1433, with `--items` narrowed and a measured runtime.

Self-test of the gate: temporarily make a View recompile on every call (for example pass a fresh `seen` to `compileCached`
in `src/core/sql/run.ts`), rebuild, and run `pnpm bench:check --items view:workout-sets`. It must fail with `zeroWarm:compile`,
`zeroWarm:check` and `zeroWarm:policy`. Revert afterwards.

## The training fixture

Modelled on Swolhalla: one member (`m1`, a user Caller) with 3 years of training, 624 workouts and 18,720 sets, plus four
noise owners (4,000 sets), so a scope bug cannot make Mantle look fast. Six public Views (workout list, per-workout sets,
personal records over GROUP BY, exercise history over a join, weekly volume over `date_trunc`, and a CTE + window + join
summary), measured as twelve items including a paged-list page and a walk over every weekly-volume page, two ref-handler Procedures that combine several Views, one inline write, and one `Store.select` item. The data is
deterministic (`seed.mjs`, mulberry32). `test/bench/fixture.test.ts` compiles the manifests for both dialects and runs every
item on an in-memory runtime.

## Another Mantle checkout (before/after)

Each variant is its own checkout with its own `pnpm install` and `pnpm build` (its dist resolves `pgsql-deparser`, `zod` and
`semver` from that worktree's `node_modules`). Run each, then compare:

```bash
pnpm bench --label develop --json /tmp/develop.json                                    # in the develop worktree
pnpm bench --label pr --json /tmp/pr.json                                              # in the PR worktree
pnpm bench:compare /tmp/develop.json /tmp/pr.json
# or, from one checkout, measure another's package:
pnpm bench --mantle ../mantle-pr/packages/mantle --label pr --json /tmp/pr.json
```

Each variant has its own cache project and database, because plans and fingerprints differ. Run both on one machine,
close together. Interleaving the two variants inside one run is deferred.

## Measuring an app (`--app`)

`mantle.bench.mjs` default-exports:

```js
export default {
  name: "my-app",
  plan: "./.mantle/generated/plan.json",   // or manifests: "./manifests" to let the harness run `mantle generate`
  sqlite: "./.bench/snapshot.sqlite",       // a SQLite snapshot, copied into the cache once; the original is never written
  handlers: "./.bench/handlers.mjs#handlers", // module#export, the handlers object (omit when the plan has no ref handlers)
  now: "2026-09-29T00:00:00Z",              // the runtime's fixed clock
  fixture: { /* anything the items need */ },
  callers: { member: { kind: "user", subject: "m1", role: null, scopes: [], credential: "session", credentialId: null, clientId: null } },
  items: "./.bench/items.mjs",              // module default-exporting the item array, or the array itself
  thresholds: { warm: { overheadUsMax: 5000, overheadRatioMax: 5 }, cold: { firstCallOverheadMsMax: 300 } },
};
```

An item is `{ name, kind, caller, minRows, zeroWarm, zeroFirst, call(ctx, args), rows(result), prepare?(ctx), samples?, warmup?,
coldSamples? }`, see `fixtures/training/items.mjs`. `ctx` is `{ runtime, store, caller, fixture }` with
`store = runtime.store.as(caller, { kind: "internal", id: "bench" })`. `invokeProcedure` takes
`{ procedure, input, caller, cause }`.

Rules and caveats:

- The plan must be generated by the same Mantle version being measured; boot refuses any other (plan version and fingerprint).
  With `manifests` the harness regenerates it per variant.
- TypeScript handlers must be bundled to ESM by the app (for example `esbuild src/handlers.ts --bundle --format=esm
  --platform=node --external:@aotter/mantle* --outfile .bench/handlers.mjs`). Handlers that import `@aotter/mantle` resolve
  their own copy, which may not be the variant under test (`instanceof DiagnosticError` can then differ); the fixture's
  handlers import nothing.
- Private snapshots stay in the app's repository. Result JSON holds timings and counts only, never rows.
- Swolhalla's CLI runs Bun with `bun:sqlite`; this harness measures the `node:sqlite` path. Do not compare its numbers with
  Bun numbers. A Bun host is a follow-up.
- Without `--mantle` the Mantle package is the app's installed `@aotter/mantle`.

## What this does not measure

Local Node over a local SQLite file. Not a Workers isolate (no workerd snapshot, bundled script, JSON module plan import or
D1 RPC), not PostgreSQL, not a bundled build: `import('@aotter/mantle')` of unbundled `dist` pays Node ESM resolution and
linking a bundled Worker never pays, so the import columns overstate cold cost in a Worker. Rows are copied (`{ ...r }`) on
both sides, as `test/d1/node-sqlite.test.ts` does. The `set-duration` write is idempotent in row counts, not in bytes
(`version` and `updated_at` move). The native cold side uses the same driver, so it carries no Mantle-specific cost by
construction.

Deferred, each its own issue: PostgreSQL dialect, interleaved `--mantle a,b`, a bundled cold variant, `--profile`
cpuprofiles, a workerd host, a Bun host, a native baseline with cached prepared statements, the CI step.
