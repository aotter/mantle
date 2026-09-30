# ADR-0035: SQL dialects — PostgreSQL syntax is Mantle SQL, a dialect runs it on one engine

**Status:** Proposed for 0.2.0. Amends ADR-0032 decisions 6 and 12, ADR-0033, and ADR-0034 decisions 2, 3, 5, 6, 7, 8 and 9.

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
- The plan (version 8) records the dialect's name and version, and both are part of the fingerprint. Boot refuses a plan compiled for another dialect. Cloud Control (ADR-0034 decision 7) accepts only D1 plans.
- A dialect and a host are different things. The dialect is the engine and is a public interface; the host is the platform entry (a Worker, `Bun.serve`, scheduling, media), which stays an application-owned preset. The open-source generator writes the Cloudflare preset only (ADR-0032 decision 6); another host's preset belongs with whoever ships it.

### 6. The D1 dialect (amends ADR-0034 decisions 5, 6 and 8)

- The built-in dialect, `@aotter/mantle/d1`. It is everything ADR-0034 describes for D1: the subset check, the IR and its validator, the SQLite rendering and codec, FTS5 and R*Tree for `mantle.*`, `"inject"` policy, and trigger-based convergence. These move out of Core into the dialect; behavior does not change.
- `@aotter/mantle/cloudflare` keeps the D1 binding driver and `d1Storage`, now built on the dialect.

### 7. `StoreSelect.search` (new)

- `StoreSelect` gains `search?: string`: rows whose declared `searchableFields`, or `id`, contain the text, under the caller's visibility like any `select`. Ordering stays `orderBy`. Each dialect's executor implements it; D1 uses its FTS5 trigram table, so Chinese substrings of three characters or more match, and a shorter query falls back to a scan.
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
- **A `host` option in the open-source CLI.** A host is a platform preset, not an engine; making it a CLI option ties platform files to the generator. Rejected in favor of the dialect interface.
- **Bare `search()` and `near()`.** Shorter, but they read as PostgreSQL functions and can collide with an engine's or an extension's own.

## How to apply

1. This ADR, then the moves with no behavior change: the shared front end out of the SQL compiler, the D1 subset check, rendering, policy lowering and convergence into `@aotter/mantle/d1`, and the interface types.
2. `mantle.*` names, plan version 8 with the dialect recorded, and `dialect` in the config.
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
> - `@aotter/mantle` no longer exports `sqliteStorage`, `runMigrations`, `readStoreInstanceId` or `Migration`; `@aotter/mantle/d1` exports them unchanged. `@aotter/mantle/spec` no longer exports the D1 allowlist (`validateProgram`, `validateIr`, `KEYS_SRC`, `KEYS`, `BARE`, `ENUM`, `FUNCS`, `TRUNC_UNITS`, `EXTRACT_FIELDS`, `MAX_RADIUS_M`, `MAX_NEAR_K`, `SQLITE_ONLY_KEYWORDS`, `SYSTEM`). `@aotter/mantle/d1` exports `validateIr`; `@aotter/mantle/d1/compile` exports `validateProgram` as `accepts`, which throws the first refusal instead of returning a list (D1 stops at the first).
> - The shared front end (`compileSql`) calls D1's `accepts` directly until `dialect` in the config selects one (How to apply 2).
> - `PreparedMantleStorage` gains `dialect`. Until How to apply 2 moves lowering to the compile side, Core calls four things on it: `check` (the IR validator, on every program), `lowering` (what the policy rewriter leaves to the engine: input and literal casts, `search`, `near` and the other Mantle functions, kept calls, subquery links, new ids, and extra wrapper columns such as D1's `_rid`), `bind` (the binds the lowering adds) and `codec`. These types stay internal until How to apply 5 makes the interface public. `name`, `version` and `policy` arrive with the plan's dialect record in How to apply 2.
> - Still to move: `auth` calls `runMigrations` and `readStoreInstanceId` (How to apply 4), `@aotter/mantle/testing` reaches D1 internals (How to apply 5), and Store's TTL sweep pages on D1's `_rid` column.
