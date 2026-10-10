# ADR-0044: Generate-time lowering for sealed Views and inline Procedures

**Status:** Accepted direction for issue #1433.

**Date:** 2026-10-10

**Amends:** ADR-0035 (where lowering runs) and ADR-0032 decision 10 (the
fingerprint also covers `lowered`).
**Clarifies:** ADR-0037 decision 4 (a restricted dialect never uses lowered
statements) and ADR-0040 (state is added only as cache seeds).

## Context

A cold isolate pays to compile every program it runs for the first time. The
measured cost of a Swolhalla first request on 0.2.0-alpha.6 was about 24 ms of
`validateIr`, 12 ms of `applyPolicy`, 17 ms of printing and 14 ms of building
JSON Schema validators. Compiling a sealed program depends only on its IR, its
declared inputs, the plan's Schemas, the dialect, the mode and the Procedure's
hook set. Every one of those is known when `mantle generate` runs. Who the
caller is reaches the statement only as binds.

## Decision

1. **Generate lowers.** `mantle generate` runs the dialect check, then the
   policy rewrite, then the dialect's printer, for every View (modes: a public
   View in `public`, any other in `caller` and `trusted`) and every inline
   Procedure (modes `caller` and `trusted`, flavour "all", with the plan's
   after-hook set as `returning`). It stores `plan.lowered`:
   `{ mantle, dialect: { name, version, key }, views, procedures }`. Only
   printed text, bind recipes and paging metadata are stored, never ASTs, so
   the plan and boot hashing stay small. `plan.lowered` is optional and covered
   by the fingerprint; `RUNTIME_PLAN_VERSION` stays 6.
2. **Paged shapes.** The page size is a bind (`LIMIT $n` on PostgreSQL, `?n` on
   SQLite), so one printed paged statement serves every page size: REST `?limit`,
   Admin's 500, MCP and handler limits. The page shape key is the cursor's NULL
   pattern and length, the search columns and the equality columns. The seeded
   shapes are no cursor, and a cursor whose every key is non-null (one per
   View, from its key count). Every other shape (a NULL key in the cursor,
   search and filters, Store JSON reads, #1432's readers) compiles on first use, as
   before.
3. **One printer.** A dialect may expose `print(ast, schemas)`, the function its
   executor prints with. Generate and the runtime print through it, and Core
   imports no engine printer. A dialect without `print` gets no `lowered`.
4. **Seeds, not a second path.** At boot the runtime seeds the compile cache
   and the paged cache with entries that carry their printed text. The
   executors run that text (`StoreStatement.printed`). The policy AST of a
   seeded entry is a lazy getter that compiles through the ordinary path only
   when something reads it. A seeded entry produces SQL and binds byte-identical
   to the cached path, and tests enforce it for the whole printer corpus on
   both dialects.
5. **Usability gate.** A runtime uses `lowered` only when the plan has it, the
   storage was **not** given `restrict` (its dialect is not `restricted`), the
   dialect has `print`, `lowered.mantle` equals the running package version, and
   the dialect's name, version and `lowerKey` equal the plan's. Otherwise
   `lowered` is ignored, a warning is logged (except under `restrict`, where
   ignoring is the contract), the existing compile path runs unchanged and
   `bootReport().lowered` names the reason: `used`, `absent`, `restricted`,
   `mantle-version`, `dialect` or `unsupported`. Boot does not refuse: Mantle
   Cloud upgrades its runtime independently of uploaded plans, and a stale
   self-hosted plan is caught by `mantle generate --check` in CI. A seeding
   failure (a malformed `lowered` with a valid fingerprint) is a warning and
   seeds nothing.
6. **Trust.** The runtime does not re-check a seeded statement: no dialect
   `check`, no `restrict`, and PostgreSQL's executor skips its read guard. The
   statement was checked where it was produced and is trusted because the plan
   is. The fingerprint is unkeyed SHA-256, so it shows integrity, not
   authorship; anyone who can rewrite `plan.json` and its fingerprint in a
   self-hosted deploy can also rewrite the handlers and the bundle, so trusting
   lowered text adds no capability there. **An operator that runs other
   people's plans must either pass `restrict` (ADR-0037), which disables lowered
   statements so every program is checked at run time, or run `verifyPlan` on
   every upload.** `verifyPlan` re-lowers the plan and requires canonical
   equality with `plan.lowered`, otherwise it reports `LOWERING_MISMATCH` at
   `plan#/lowered`; it bounds `lowered` first (known programs only, bounded
   size). A lowering `verifyPlan` cannot re-derive (another Mantle version or
   dialect, or a dialect that cannot print) is refused, never skipped, because
   a runtime of that version would seed it unchecked and `lowered.mantle` is
   only a string the plan's author writes. The comparison is skipped only
   under `restrict`, where no runtime uses lowered statements. Probe runs (`seen`,
   `unsafeNoVisibility`) and Store writes with statuses never use seeds (the
   existing compile cache bypass).
7. **Validators.** The Procedure and View input/output validators are built
   eagerly per plan at `createMantle()` (module scope in the generated
   preset), not on the first call (`planValidators`, a `WeakMap` per plan). This landed in its own change; generating
   validator code instead would be a second JSON Schema implementation beside
   zod's importer.

## Consequences

- `plan.json` grows by roughly the printed SQL (text only): the reference
  service's plan doubles (15.5 KB to 33 KB), which `docs/benchmarks/lowered-cold-start.md`
  reports with the cold-start numbers.
- A Mantle version bump changes the plan (through `lowered.mantle`) and so its
  fingerprint, and storage convergence re-checks once after an upgrade. The
  release process bumps `MANTLE_VERSION` with `package.json` and regenerates
  `docs/examples/reference-service`.
- **Drift inside one version.** `lowered.mantle` cannot detect a policy or
  printer change merged at the same version number. A plan generated before
  such a merge seeds stale SQL silently. The mitigations are `mantle generate
  --check` in CI (it compares the regenerated `plan.json` byte for byte) and,
  in this repository, a test that runs `generate --check` and `verifyPlan` on the
  committed reference-service plan.
- Per-isolate cost moves from compile to cache seeding: allocation proportional
  to the number of lowered programs, no AST walks. Seeds live in the compile
  cache, which is keyed by the plan's own objects and the dialect object, so
  they serve the one storage adapter whose dialect object the runtime booted
  with, not a second adapter on the same plan.
- A platform that validates uploaded plans (Mantle Cloud) must accept the new
  optional top-level `lowered` key, and run `verifyPlan` or pass `restrict`.
- Still on the cold path, and not covered: boot's `planFingerprint` (canonical
  JSON and SHA-256 over a larger plan, about 8 ms cold for the reference
  service), lifecycle "one"-flavour recompiles and `preRead`'s `applyPolicy` on
  publishing or before-hooked Schemas, cursors with a NULL key, search and filter
  shapes, Store JSON reads (#1432), non-UTC PostgreSQL time zones (the key
  differs, so the plan falls back), third-party dialects (no runtime dialect at
  generate), and V8's first execution of the code a call reaches.
- Warm calls are unchanged: they already hit the compile cache.

## Rejected alternatives

- **Lowering at boot.** Still on the critical path of the first request.
- **Storing policy or paged ASTs in the plan.** Plan size and boot canonical-hash
  cost grow; text is enough.
- **Pre-printed fragments.** A second printer, rejected in #1432.
- **Refusing boot on a version mismatch.** Breaks Cloud upgrades.
- **Priming executor WeakMaps instead of carrying the text with the statement.**
  A seeded entry would depend on which executor was primed, and two runtimes
  share the dialect singleton and the compile cache.
- **Enumerating page sizes.** REST, Admin and handlers each pass their own
  limit; a bind removes the enumeration.

## How to measure

Cold first call versus second call: Mantle CPU (wall minus SQL), counters for
check, `applyPolicy` and print (asserted in `test/core/lowered-cold.test.ts`),
boot fingerprint time, and `plan.json` size. `scripts/bench-cold-start.mjs`
runs fresh processes for the lowered plan and for the same plan without
`lowered`.
