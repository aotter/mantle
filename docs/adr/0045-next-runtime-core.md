# ADR-0045: One runtime core for Next: dialect, driver, row rules and a generic Store

**Status:** Proposed (tracking issue #1465).

**Date:** 2026-10-12

**Amends:** ADR-0043 (Store readers move from runtime compilation to a generated, generic Store) and ADR-0044 (generated
code calls shared runtime modules instead of inlining driver work).

## Context

Next (`@aotter/mantle-next`) replaces Core as Mantle 0.2.0. Its generated Views and Procedures, the Store that custom
handlers use, and the Better Auth adapter each talk to SQLite (bun:sqlite, D1) and PostgreSQL (Bun.SQL, postgres.js).
Before this decision each of them spelled placeholders, identifier quoting, LIKE escaping, the date-time wire form,
bind evaluation, driver calls and transaction outcomes on its own, mixing two different questions behind one
`if (pg)`: how SQL is written and how a handle is called. The first Store prototype also carried Core-printed SQL for
every Schema (7-8 KB each) to keep row rules in one place.

## Decision

1. **Two axes, one module each.** A *dialect* says how SQL is spelled (`kernel/dialect/sqlite.ts`,
   `kernel/dialect/postgres.ts`, shared pieces in `dialect/common.ts`): placeholders, quoting, LIKE escape,
   case-insensitive compare, keyset NULL order, casts, and the date-time/date wire-form templates (generic over the
   operand, so the generator passes an AST node and the Store a column). A *driver* says how a handle is called
   (`kernel/driver/bun-sqlite.ts`, `kernel/driver/d1.ts`, `kernel/driver/postgres.ts`): `read`, `run`, and only the
   atomicity the driver really has (a D1 batch with a row assertion, a bun:sqlite transaction, a PostgreSQL `begin` with
   uncertain-COMMIT classification). There is no common fake transaction interface. Generated code imports the one
   dialect and driver of its target; nothing branches on the dialect at runtime.
2. **One PostgreSQL driver.** It is written against the `unsafe`/`begin` shape that Bun.SQL and postgres.js share. Bun
   uses Bun.SQL; Workers with Hyperdrive use postgres.js. No node-postgres adapter is kept.
3. **One evaluator for binds and one for input scalars.** `kernel/binds.ts` evaluates Core's bind recipes (`uid`, `role`,
   `now`, `cutoff`, `const`, `input`, `version`) for generated Views, generated Procedures and the Store.
   `kernel/scalars.ts` holds the ISO date-time/date input encoders.
4. **Row rules are data, defined once in Core.** `rowPolicy(schema, mode)` and `writePolicy(schema, kind, options)`
   (`@aotter/mantle/spec`) state scope, TTL, published visibility and the write fills, sets and lock as terms with bind
   recipes. Core's policy rewriter renders them into any SQL at build time; the generator writes the same terms into
   each Schema's fact record; the runtime Store renders them to SQL text with the dialect. Neither renderer decides a
   rule. A test compares Store rows with Core-compiled View rows for every fixture Schema and mode.
5. **The Store is generic.** One runtime (`kernel/store.ts`, with `kernel/where.ts`) plus a fact record per Schema
   (table, columns with types and flags, row terms per mode, write terms; about 250-350 bytes gzip). API:
   `store(db, caller).collection(name)` with `findById`, `find`, `first`, `count`, `insert`, `update`, `delete`; `where`
   is a typed AND-only object; `find` pages with keyset cursors. Column names are always quoted by the dialect. Types
   are generated and compile-time only: they restrict columns, value types and `orderBy` to indexed columns. Complex
   reads are `surface: internal` Views called through `store.views`.
6. **The Store does not check `requires`.** As in 0.2, `requires` gates Views and Procedures; a custom handler runs
   after its Procedure's gate. The Store applies row rules only.

## Consequences

- Each concern has one home; the Better Auth adapter keeps only Better Auth's own semantics (OR grouping, joins).
- Warm cost on bun:sqlite over the same SQL run by hand (p50): generated View +0.1 µs; Store `findById` +0.17 µs,
  `find` (50 rows) +7 µs, cursor page +11 µs, `count` +0.8 µs, `update` +5 µs. Exploratory, not a formal run (AGENTS.md).
- A Schema's fact record replaces 4-8 KB of printed SQL; `generated.ts` for the purchase fixture drops from 45.9 KB to
  31.3 KB. The PostgreSQL Worker bundle drops from 112 KB to 63 KB with postgres.js.
- The package ceiling rises to 128 KiB so `.d.ts` files keep their documentation for coding agents.
- Core tests need Node ≥ 22.22 (`node:sqlite` `columns()`); `.nvmrc` pins 22.14.0 and should move.
- Open: Store `insert` generates ids in JS (Core's lowering does it in SQL) and reports a unique clash as a native error,
  not `CONFLICT`. Both must follow Core's rules before release.
