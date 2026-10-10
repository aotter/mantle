# ADR-0035: SQL dialects — PostgreSQL syntax is Mantle SQL, a dialect runs it on one engine

**Status:** Accepted for 0.2.0. Amends ADR-0032 decisions 6 and 12, ADR-0033, and ADR-0034 decisions 2, 3, 5, 6, 7, 8 and 9. Amended by its PostgreSQL dialect amendment (#1293), [ADR-0036](0036-host-and-dialect.md) and [ADR-0037](0037-postgresql-is-the-reference-dialect.md).

**Date:** 2026-09-30

**Related:** ADR-0032, ADR-0033, ADR-0034

## Context

ADR-0034 made manifests SQL and D1 the one engine: its decision 2 calls the dialect "SQLite semantics in the syntax PostgreSQL and SQLite share", and decision 6 gives the Store one executor. The syntax is already PostgreSQL's (`libpg-query` parses it), and conformance case 6 already holds D1 to PostgreSQL's results. What is missing is a boundary: the D1 subset, the SQLite rendering, policy injection and storage convergence are spread through Core, so no other engine can run a Mantle plan without a fork.

A service that needs another engine should be able to add one. Mature SQL tools split the same way: SQLGlot and Apache Calcite parse to one tree and generate per dialect; Kysely's `Dialect` bundles a driver, a query compiler, an adapter and an introspector; SQLAlchemy ships a dialect compliance suite a third-party dialect must pass. Mantle adopts that shape. The open-source repository ships one dialect, D1, and the interface and test suite that let anyone write another; an enterprise PostgreSQL dialect is the first one written outside it.

## Decision

### 1. Mantle SQL is PostgreSQL syntax, pinned (amends ADR-0034 decision 2)

- A View or Procedure is written in PostgreSQL syntax, and its canonical form is the parse tree of `libpg-query` 18, PostgreSQL 18's own parser. The parser version is part of the language: moving to another major is a deliberate Mantle version change, recorded in an amendment.
- Its meaning is PostgreSQL's. A dialect either gives PostgreSQL's result for a construct or refuses it at compile time with a position in the source; it never approximates. (ADR-0034 conformance case 6 is this rule for D1.)
- A manifest that one dialect accepts may be refused by another. The D1 dialect accepts the ADR-0034 subset; a PostgreSQL dialect can accept nearly all of PostgreSQL.

### 2. Mantle's own functions live in the `mantle` schema (amends ADR-0034 decision 9)

- `search()`, `search_rank()`, `near()` and `distance()` become `mantle.search()`, `mantle.search_rank()`, `mantle.near()` and `mantle.distance()`, as `auth.uid()` and `auth.role()` already are. An unqualified call is PostgreSQL's function of that name, never Mantle's. 0.2.0 is unreleased, so there is no old spelling to keep.
- A function is Mantle's exactly when its schema is `mantle` or `auth`. Each dialect lowers every `mantle.*` function it supports and refuses the rest with a position; the D1 dialect lowers all four to FTS5 and R*Tree (ADR-0034 decision 9), and a dialect may refuse them and leave authors to the engine's own syntax.
- `auth.uid()` and `auth.role()` are required of every dialect: policy is written with them.

### 3. The dialect interface

A dialect is an npm module with two entry points, so the parser stays out of the runtime bundle (ADR-0034 decision 3):

- **Compile side** (`<dialect>/compile`, loaded only by the CLI):
  - `accepts(tree, context)`: every refusal, each with its source position. Context is the linked manifest set: declared Schemas and their fields, inputs, and surfaces.
  - `lower(tree, context)`: the dialect's statement payload for the plan, opaque to Core, with `mantle.*` calls lowered.
  - `outputs(tree, context)`: a View's row type for the typed `mantle.ts`, by ADR-0034's rule (an output that reads a Schema field unchanged has its type; any other output is `unknown`).
- **Runtime side** (`<dialect>`, loaded by the host entry):
  - `executor`: a `StoreExecutor` that runs plan payloads and renders the Store's structured operations (`select`, `write`, `search`) to the engine.
  - `policy`: `"inject"`, where Mantle's policy rewriter adds visibility and ownership to every relation position (ADR-0034 decision 8), or `"native"`, where the engine enforces them (for example PostgreSQL row-level security) and the dialect writes that enforcement during convergence.
  - `converge(plan)`: ADR-0033's storage convergence in the engine's DDL, including the tables Mantle owns (the migration ledger, boot state, site and media).
  - `codec`: the Store's wire values. They are the same on every dialect (ADR-0034's timestamps, `numeric` and booleans), whatever the engine stores.
- There are no capability flags. What a dialect cannot run, its compile side refuses.
- Core keeps the Store API, the runtime, the policy rewriter as a library any `"inject"` dialect uses, and the interface's types. It holds no engine-specific code.

### 4. What every dialect gets before `accepts`

The CLI front end is shared and dialect-free. It parses, links, and refuses what no dialect may run:
- A View is one `SELECT` (with `WITH`). A Procedure is `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `MERGE` statements, with `WITH` and `RETURNING`. DDL, `SET`/`RESET`, transaction control, `COPY`, `DO`, `CALL`, `LISTEN`/`NOTIFY` and `PREPARE` are refused.
- Every relation anywhere in the tree (`FROM`, joins, `LATERAL`, and subqueries in the select list, `WHERE`, `HAVING` and `RETURNING`) is a declared Schema or a CTE of the same statement; Mantle's tables and the identity provider's are never named.
- `input.<name>` is a declared input. The `mantle` and `auth` schemas hold only the functions of decision 2.
- Functions that change session or server state, or reach outside the database, are refused whatever the dialect: `set_config` and `current_setting` of `mantle.*`, advisory locks, file and large-object access, `dblink`, backend signals and `pg_reload_conf`. A `"native"` dialect relies on this list, because a caller setting could otherwise be forged from SQL.

### 5. Choosing a dialect (amends ADR-0032 decision 12)

- `mantle.config.json` version 2 gains `dialect`, an npm module name. Absent, it is the built-in D1 dialect, so existing projects do not change. There is no CLI flag and no `host` field.
- The plan records the dialect's name and version, and both are part of the fingerprint. Boot refuses a plan compiled for another dialect. Cloud Control (ADR-0034 decision 7) accepts only D1 plans.
- A dialect and a host are different things. The dialect is the engine and is a public interface; the host is the platform entry (a Worker, `Bun.serve`, scheduling, media), which stays an application-owned preset. The open-source generator writes the Cloudflare preset only (ADR-0032 decision 6); another host's preset belongs with whoever ships it.

### 6. The D1 dialect (amends ADR-0034 decisions 5, 6 and 8)

- The built-in dialect, `@aotter/mantle/d1`. It is everything ADR-0034 describes for D1: the subset check, the IR and its validator, the SQLite rendering and codec, FTS5 and R*Tree for `mantle.*`, `"inject"` policy, and trigger-based convergence. These move out of Core into the dialect; behavior does not change.
- `@aotter/mantle/cloudflare` keeps the D1 binding driver and `d1Storage`, now built on the dialect.

### 7. `StoreSelect.search` (new)

- `StoreSelect` gains `search?: string`: rows whose declared `searchableFields` contain the text, or whose `id` is the text, under the caller's visibility like any `select`. Ordering stays `orderBy`. Each dialect's executor implements it; D1 uses its FTS5 trigram table, so Chinese substrings of three characters or more match, and a shorter query falls back to a scan.
- Admin's collection search box sends `search` instead of building `like` conditions itself.
- The manifest key is `searchableFields`; ADR-0034 decision 9 wrote `search`, and the plan stores it as `search`.

### 8. The dialect compliance suite

- `@aotter/mantle/testing` becomes the dialect compliance suite: every ADR-0034 conformance case, the relation-position probe, the wire-value checks and the `StoreSelect.search` checks, each against a dialect's runtime side on a real engine, and the refusal cases against its compile side. A case whose feature a dialect refuses at compile time passes by that refusal.
- A dialect is supported when it passes the suite. The D1 dialect runs it on local D1 in CI, as today.

### 9. The identity provider's SQL

- `createMantleAuth` stops writing its own SQLite. What it still writes in SQL (members, invitations, consents, linked accounts, the bootstrap owner, its schema ledger) moves to Better Auth's own Kysely instance, which speaks every engine Better Auth supports. Auth then depends on Better Auth's adapters, not on a Mantle dialect.

## Consequences

- Another engine is a module, not a fork, and it proves itself with the same suite D1 passes.
- Core loses its SQLite code; the D1 dialect owns it. Mantle Cloud stays D1-only.
- Manifests name Mantle's extensions explicitly (`mantle.search(...)`), and anything unqualified reads as PostgreSQL.
- A plan is dialect-specific; moving a service to another engine is a recompile.
- The interface is new public surface, versioned with the plan.

## Alternatives

- **ISO or ANSI SQL as the canonical language.** There is no authoritative parser for it, and PostgreSQL is the implementation closest to it. Naming the standard would still mean choosing one vendor's parser.
- **Substrait.** A cross-engine relational-plan standard, but it describes plans after planning, it is not authored, and neither D1 nor most transactional engines consume it; every dialect would still render SQL from it.
- **Mantle's own neutral tree.** A new language to specify and teach; ADR-0034 left the JSON grammar for SQL for this reason.
- **A `host` option in the open-source CLI.** A host is a platform preset, not an engine; making it a CLI option ties platform files to the generator. Rejected in favor of the dialect interface. *Superseded by ADR-0036: presets are written once and owned by the application, so the generator owns no platform file after the first run.*
- **Bare `search()` and `near()`.** Shorter, but they read as PostgreSQL functions and can collide with an engine's or an extension's own.

## How to apply

1. This ADR, then the moves with no behavior change: the shared front end out of the SQL compiler, the D1 subset check, rendering, policy lowering and convergence into `@aotter/mantle/d1`, and the interface types.
2. `mantle.*` names, the dialect recorded in the plan, and `dialect` in the config.
3. `StoreSelect.search`, and Admin's search box on it.
4. `createMantleAuth`'s SQL onto Better Auth's Kysely instance.
5. The compliance suite over the dialect interface, run on the D1 dialect.

## Conformance cases

1. The shared front end refuses, with a position: DDL, `SET`, transaction control, `COPY`, `DO`, `set_config('mantle.…', …)`, a Mantle or identity-provider table in `FROM` and in a scalar subquery, an undeclared `input`, and an unknown `mantle.*` or `auth.*` function.
2. An unqualified `search(…)` is not Mantle's: the D1 dialect refuses it as an unsupported function, and `mantle.search(…)` behaves as ADR-0034 decision 9's `search` did.
3. A plan compiled for another dialect is refused at boot; a config without `dialect` compiles for D1.
4. `StoreSelect.search` on D1: a three-character Chinese substring matches, a two-character one falls back to a scan, another owner's rows are absent.
5. The D1 dialect passes the compliance suite on local D1, and every public barrel except the moved internals exports what it did before.

## Implementation status

Proposed.

> **Amendment (How to apply 1, 2026-09-30):** The move, and the names it changes. Behavior does not change.
> - `@aotter/mantle` no longer exports `sqliteStorage`, `runMigrations`, `readStoreInstanceId` or `Migration`; `@aotter/mantle/d1` exports them unchanged. `@aotter/mantle/spec` no longer exports the D1 allowlist (`validateProgram`, `validateIr`, `KEYS_SRC`, `KEYS`, `BARE`, `ENUM`, `FUNCS`, `TRUNC_UNITS`, `EXTRACT_FIELDS`, `MAX_RADIUS_M`, `MAX_NEAR_K`, `SQLITE_ONLY_KEYWORDS`, `SYSTEM`). `@aotter/mantle/d1/compile` exports `validateProgram` as `accepts`, and the runtime reaches the same validator as the dialect's `check`, which throws the first refusal instead of returning a list (D1 stops at the first).
> - The shared front end (`compileSql`) calls D1's `accepts` directly until `dialect` in the config selects one (How to apply 2).
> - `PreparedMantleStorage` gains `dialect`. Core calls four things on it: `check` (the IR validator, on every program), `lowering` (what the policy rewriter leaves to the engine: input and literal casts, `search`, `near` and the other Mantle functions, kept calls, subquery links, new ids, and extra wrapper columns such as D1's `_rid`), `bind` (the binds the lowering adds) and `codec`. These types stay internal until How to apply 5 makes the interface public. `name`, `version` and `policy` arrive with the plan's dialect record in How to apply 2.
> - Still to move: `auth` calls `runMigrations` and `readStoreInstanceId` (How to apply 4), `@aotter/mantle/testing` reaches D1 internals (How to apply 5), and Store's TTL sweep pages on D1's `_rid` column.

> **Amendment (How to apply 2, 2026-09-30):** The names, the plan record and the config key.
> - Mantle's functions are spelled `mantle.search`, `mantle.search_rank`, `mantle.near` and `mantle.distance` everywhere: manifests, the D1 allowlist and its lowering. An unqualified `search(…)` is refused as an unsupported function.
> - The plan records `dialect: { name, version }`, inside the fingerprint. Its version is 6 for all of 0.2.0: the plan version changes only between released formats (0.1.x shipped 5), never within an unreleased one, because no plan of an unreleased shape exists to refuse. Development had moved it to 7 and 8; both are gone. The D1 dialect is `{ name: "@aotter/mantle/d1", version: "1" }`; its version changes when what a D1 plan means changes. `dialect` moves from `PreparedMantleStorage` to `MantleStorageAdapter`, and the runtime's `MantleDialect` gains `name` and `version`, so boot compares them with the plan before it converges anything and refuses a mismatch with `PLAN_FINGERPRINT_MISMATCH`, as it refuses another plan version.
> - `@aotter/mantle/d1/compile` exports `name`, `version` and `accepts`. `@aotter/mantle/spec` exports `SqlDialect`, the compile side's type, and `compileSql`, `compileLinkedPlan` and `compilePlan` take one as their last argument, D1 when omitted.
> - `mantle.config.json` version 2 takes an optional `dialect`, a package name (never a path). `mantle generate` resolves `<dialect>/compile` from the project with `require.resolve`, so the package's `exports` must give it a `default` (or `require`) condition, imports it and compiles with it; absent, or `@aotter/mantle/d1`, it is the built-in dialect. The config's other keys are unchanged.
> - The shared front end refuses decision 4's list before `accepts`: statements other than `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `MERGE`; a relation that is not a declared Schema or a CTE of the statement, or that names a schema; an undeclared `input.<name>`; a `mantle.*` or `auth.*` function that decision 2 does not define; and the session, server and outside-access functions (`set_config` and `current_setting` of a `mantle.*` setting or of a name that is not a literal, advisory locks, file and large-object access, `dblink`, backend signals, `pg_reload_conf`, `pg_notify`, sequences, and the functions that run SQL text: `query_to_xml` and its kin, `ts_stat`, `ts_rewrite`); `SELECT … INTO`. Function names are compared as PostgreSQL resolves them (a catalog prefix and `pg_catalog.` dropped); a relation that names a CTE in scope, by PostgreSQL's scoping, is tagged `cte`.
> - Lowering stays on the runtime side: Store builds its JSON queries at run time (and `StoreSelect.search`, How to apply 3), so they need it there. The compile side's `lower` and `outputs` are not built; `viewOutputs` reads a View's row type for every dialect.


> **Amendment (How to apply 4, 2026-09-30):** Decision 9 as built. Better Auth does not expose its Kysely instance, and reaching it would add a dependency (`@better-auth/kysely-adapter`) for a handful of statements, so `createMantleAuth` does not use Kysely:
> - Its tables come from Better Auth's own `getMigrations(...).runMigrations()`; the `_mantle_migrations` ledger row for them is gone. A digest of Better Auth's table definitions in `_mantle_boot_state` (`auth-schema`) lets a prepared database skip the introspection, so a warm isolate reads one row. Better Auth's statements are not idempotent, so an isolate that races another retries (up to five times) until the other has finished. Mantle adds one index, `user_role_idx`, in portable SQL.
> - Revoking a consent deletes the consent and revokes its tokens in one batch first, so no new code is issued for it without a prompt; then its pending authorization codes are found and deleted through Better Auth's adapter (`findMany` paged past the rows it keeps, `deleteMany`), which reads the JSON value in code instead of `json_extract`.
> - What Better Auth's API has no call for (the bootstrap owner's guarded promotion, member paging, the invite guard, linked accounts, consents and the MCP grant check) stays one statement each over the `DatabaseDriver`, in portable SQL: camelCase names and `"user"` quoted, binds numbered, a write's count read from `RETURNING`, no engine functions. The two guarded writes stay single statements, which SQLite and D1 serialize, so their guards hold there; on an engine with concurrent writers (PostgreSQL under READ COMMITTED) that engine's driver must run them serializable, or two first sign-ups could both become owner.
> - The session cache's namespace (`_mantle_boot_state`'s instance id) is read by auth itself. `@aotter/mantle/d1` no longer exports `runMigrations`, `readStoreInstanceId` or `Migration`; it exports `sqliteStorage` only. `auth` no longer reaches `d1`.

> **Amendment (How to apply 5, 2026-09-30):** The compliance suite over the dialect interface.
> - `runStorageConformance({ create, compile })`: `create` returns, per case, a fresh database as `{ storage, driver, cleanup }`, where `storage` is the dialect's `MantleStorageAdapter` (its runtime side: `prepare` converges the fixture Schemas and returns the executor, and `dialect` carries the check, lowering and codec) and `driver` is the same database for the fixture's own seeding and reads, in plain SQL over the storage layout of ADR-0033, with typed values (timestamps, numerics, JSON) through the dialect's codec. `prepare` receives a whole `RuntimePlan` for the fixture Schemas. `compile` is the dialect's compile side, D1 when omitted. A corpus item the compile side refuses as unsupported (`SQL_UNSUPPORTED`, `SQL_FUNCTION`, `SQL_TYPE`) passes by that refusal, and the check names it; any other refusal, and a refusal in any other case, fails.
> - The generic cases are requisition, stock, report View, before hook, policy (the relation-position probe), search and places, the printer corpus (rows, not SQL text) and Store (including `StoreSelect.search`). What depends on how D1 spells or stores things (the printed SQL, SQLite's query plan, FTS5's trigram floor, D1's `meta.changes`, the storage encodings of the types case, and that D1 accepts the whole corpus) is D1's own test, `test/d1/dialect.test.ts`. `testing` no longer reaches `d1`.
> - **Not yet dialect-neutral: computed outputs.** Store decodes a View's output column only when it reads a Schema field unchanged; a computed typed value (`now()`, `date_trunc`, a numeric literal, a `CAST` to bool) reaches the caller as the engine stores it. So the corpus rows that compute such values, and the whole types case (integer division, exact numerics, the interval boundary, `round`, `date_trunc` and `extract` across daylight saving), expect D1's encodings, and the types case runs only in D1's test. Typing each output column in the compile side and decoding it in Store is the prerequisite for a second dialect; with it, the types case's View checks return to the generic suite and only its storage reads stay in D1's test.

> **Amendment (PostgreSQL dialect, #1293, 2026-10-02):** The second dialect ships in this repository, not outside it: `@aotter/mantle/postgres` and `@aotter/mantle/postgres/compile`. This amends the Context's "an enterprise PostgreSQL dialect is the first one written outside it"; decision 5's "Cloud Control accepts only D1 plans" stands for now. A consumer service behind Cloudflare Hyperdrive wants PostgreSQL from day one, and a dialect inside the repository is the one the compliance suite keeps honest.
> - **What it accepts** (*replaced by ADR-0037: the PostgreSQL dialect runs the reference profile, and D1 the base subset*): D1's subset (decision 6) less SQLite's own functions (`typeof`, `hex`, `json_extract`, `json_set`, `json_insert`, `json_remove`), refused with a position. A PostgreSQL manifest therefore compiles for D1 too. `mantle.near`, `mantle.distance` and `mantle.search_rank` are lowered without an extension (a range and a haversine; an occurrence count instead of bm25).
> - **Values:** columns have native types. The executor asks node-postgres for every value as text and decodes it by the column's type OID, so computed outputs are typed wire values, which is the prerequisite How to apply 5 named, for this dialect. The printer corpus therefore accepts, per item, D1's encoding or the typed wire values (`typedRows`).
> - **Core:** the `now` and `cutoff` binds and the TTL sweep's bind go through `codec.encode("timestamptz", …)` (the identity on D1), and `PolicyLowering.system` lets a dialect type `now()`'s bind (PostgreSQL cannot infer `$1 - interval '1 hour'`). D1's output is unchanged.
> - **Concurrency:** every write batch is one `SERIALIZABLE` transaction, retried on 40001/40P01, which is the "engine's driver must run them serializable" that How to apply 4 asked for, for auth's guarded writes too (`pgDatabaseDriver`, `pgPool` for Better Auth).
> - **Driver:** structural node-postgres types; `connect` opens a client per operation, as Workers and Hyperdrive need. Statements are sent one at a time; a pipelining driver is the upgrade if round trips show.
> - **Same results as D1 where Mantle decides them:**
>   - Text columns use `COLLATE "C"`.
>   - A default NULL order is stated as Core pages Views: first ascending, last descending.
>   - Every transaction pins `DateStyle`, `IntervalStyle`, `extra_float_digits` and `TimeZone`.
>   - Reads run in read-only transactions, so Hyperdrive's cache never answers them.
>
>   Elsewhere the meaning is PostgreSQL's (`LIKE` case, division by zero, `->>` returning text).
> - **Not yet:** site settings and media (D1 only), a trigram or GiST index behind `searchableFields` and `format: geo`, and `mantle generate --check`'s storage dry run (D1 only).

## 2026-10-10 amendment — Schema readers (ADR-0043)

- **Decision 7:** `StoreSelect.search` is the reader's `search` (`find({ search })` and `first({ search })`): the same text match over the declared search fields, or the id, under the caller's visibility. The compliance cases run on readers.
- **Lowering:** the runtime lowering described above still holds. Readers lower a query shape on its first use and keep the compiled shape (ADR-0043); the plan format and fingerprint are unchanged.
