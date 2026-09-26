# ADR-0030: Store — one persistence object over one relational query AST

**Status:** Accepted for 0.1.5 (#1151). Runtime slice first; manifest grammar follows under grammar-revise.

**Date:** 2026-09-26

## Context

Entry persistence grew parallel paths: builtin-op use cases over `EntryRepository`, `ctx.writeAtomically` over `AtomicEntryWriter`, declarative Views with their own Filter AST, typed-query bindings, `runtime.entries` readers and the TTL sweeper. Each re-implements filters, OCC and SQL for every adapter, and the public vocabulary stops at id-addressed single rows. A consumer deleting one workout (swolhalla/swolhalla-mantle#15) expands it to two statements per row — about 51 queries for a small workout and 615 for a large one — or bypasses Mantle with raw SQL against Mantle-owned tables.

## Decision

**Store** is the single persistence object: `ctx.store` inside Procedures (bound to the caller) and `runtime.store` for trusted host code.

- Queries are a closed **relational AST with a JSON shape**: SQL vocabulary and semantics (`select`/`from`/`where`/`orderBy`, NULL, subqueries), never a SQL string. Adapters compile it; values are always bound and identifiers come only from the linked Schema, so row scope and OCC can be injected structurally later.
- Where grammar: `{ column: value }` is equality and sibling keys AND; `{ column: { eq, ne, gt, gte, lt, lte, in, notIn, isNull } }`; `and`/`or`/`not`; `in`/`notIn` accept a `{ select, from, where }` subquery. Columns are scalar Schema fields plus the native `id`, `status`, `version`, `createdAt`, `updatedAt`, `authorId`. `ne` follows SQL and excludes NULL.
- Rows are flat (native columns next to Schema fields; the parser forbids clashes). Pagination is keyset `limit` (1–500) / `cursor` over one scalar `orderBy` column with `id` as tie-breaker. Declared-required fields can still be NULL in storage (publishing drafts validate partially; added columns start NULL), so NULLs sort last in either direction and the cursor carries a NULL value; no row falls between pages. A cursor is bound to its Schema, column and direction. TTL-expired rows stay hidden everywhere, including subqueries (ADR-0028).
- `select` returns every lifecycle status: it is a trusted-handler read, not a public View. A Procedure exposed to callers must filter `status` itself (ADR-0025 applies to public Views only). `ne` and `not` follow SQL three-valued logic and exclude NULL; subqueries exclude NULL values so `notIn` behaves like its array form (a NULL left-hand value still matches `notIn` only when the list is empty, as in SQL). A `where` nests at most 16 levels and counts at most 256 objects, comparisons and subqueries in total. A Schema field named `and`, `or` or `not` cannot be filtered.
- Storage support is an optional `StoreReader` capability; absent support is `RESOURCE_UNAVAILABLE`. Invalid queries are `INPUT_VALIDATION_FAILED`. A statement binds at most 100 values (D1's limit) on every adapter.
- `store.view(name, options)` runs a named View with the caller's context; `store.id()` returns an entry id.
- Runtime validates and snapshots Store queries before calling a storage adapter, including nested set-delete filters. Storage adapters retain dialect-specific limits and SQL compilation. `sweepExpired` is host maintenance and rejects every caller-bound Procedure Store, including an anonymous caller.

Delivery order (each a reviewed PR): (1) `select`, `view`, `id` — this ADR's first slice; (2) `store.write(ops)` with `insert`/`update`/`delete`, `lock` and `expect`, set-based deletes over live rows only, rejected on Schemas with per-row delete hooks and on publishing Schemas (published entries are protected), replacing `ctx.writeAtomically`; (3) manifest grammar (handler `ref | store`, View `select`, Schema `scope`) and removal of the parallel read paths, under grammar-revise.

## Consequences

- One compiler per dialect replaces per-path SQL generators as later slices land; the SQLite family (D1, Bun, libSQL) implements it first, IndexedDB fails closed until it opts in.
- Handlers get multi-Schema reads without raw SQL; Web and Admin keep `EntryReader` until the grammar slice.
- Breaking changes are limited to 0.1.5-alpha APIs until the grammar slice, which ships with a `mantle-update` codemod.

## Alternatives

MongoDB-flavoured operators (`deleteMany`, `$in`) were considered first and rejected: every backend is relational, document semantics (nested paths, missing versus null) mismatch SQLite, and SQL is the vocabulary agents know best. SQL strings cannot carry injected scope and locks without a parser. Extending `writeAtomically` alone would add a fifth path.

## New folder rationale

`usecase/store/` holds the Store facade that binds storage capability, the View executor and the id generator to one caller context; it has no storage or platform imports.
