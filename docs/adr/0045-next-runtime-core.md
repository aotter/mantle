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
every Schema (7-8 KB each), and its second a per-Schema column table and write block (519-827 bytes each) that repeated
what the database and the generated types already say.

## Decision

1. **Two axes, one module each.** A *dialect* says how SQL is spelled (`kernel/dialect/sqlite.ts`,
   `kernel/dialect/postgres.ts`, shared pieces in `dialect/common.ts`): placeholders, quoting, LIKE escape,
   case-insensitive compare, casts, the date-time/date wire-form templates (generic over the operand, so the generator
   passes an AST node and the Store a column) and how that engine words a unique-index clash (`unique`; PostgreSQL's
   `sqlstate` too). A *driver* says how a handle is called (`kernel/driver/bun-sqlite.ts`, `kernel/driver/d1.ts`,
   `kernel/driver/postgres.ts`): `read`, `run`, and only the atomicity the driver really has (a D1 batch with a row
   assertion, a bun:sqlite transaction, a PostgreSQL `begin` with uncertain-COMMIT classification). There is no common
   fake transaction interface. Generated code imports the one dialect and driver of its target; nothing branches on the
   dialect at runtime.
2. **One PostgreSQL driver.** It is written against the `unsafe`/`begin` shape that Bun.SQL and postgres.js share. Bun
   uses Bun.SQL; Workers with Hyperdrive use postgres.js. No node-postgres adapter is kept.
3. **One evaluator for binds and one for input scalars.** `kernel/binds.ts` evaluates Core's bind recipes (`uid`, `role`,
   `now`, `cutoff`, `const`, `input`, `version`) for generated Views, generated Procedures and the Store.
   `kernel/scalars.ts` holds the ISO date-time/date input encoders.
4. **Row rules are Core's, emitted once.** `rowPolicy(schema, mode)` and `writePolicy(schema, kind, options)`
   (`@aotter/mantle/spec`) state scope, TTL, published visibility and the write fills, sets and lock as terms with bind
   recipes; Core's policy rewriter renders them into any SQL at build time. For the Store the generator evaluates the same
   two functions **once**, for a placeholder Schema whose scope column is `$scope` and TTL column `$ttl`, into one shared
   `Rules` object in `generated.ts`. A Schema's runtime fact supplies its own scope and TTL, and `expand(rules, fact)`
   (in the kernel, used by the runtime and by the generator alike) substitutes them and drops a term the Schema lacks.
   For every Schema the generator evaluates Core's own `rowPolicy` caller and trusted, `writePolicy` insert, update with
   lock and delete lock, and refuses generation if the expansion is not identical: the shared object cannot silently diverge from Core,
   and Core's two functions stay the only definition. The rules carry no per-Schema copy. (Rejected: per-Schema terms,
   which repeated the same 200 bytes for each Schema, and a hand-written rule set in the runtime, which is a second
   definition.) A test compares Store rows with Core-compiled View rows for every fixture Schema and mode.
5. **The Store is a document-database-style driver.** One runtime (`kernel/store.ts`, with `kernel/where.ts`), one shared
   `Rules` and, per Schema, a fact of 2-60 bytes keyed by the table name: `{ s?: scope column, ttl?: [column, seconds],
   pub?: 1, ts?: [date-time columns], d?: [date columns] }`. API: `store(db, caller).collection(name)` with `findById`,
   `find`, `first`, `count`, `insert`, `update`, `delete`; `where` is a typed AND-only object; `find` pages with keyset
   cursors (percent-encoded JSON `[value, id]`, bound as parameters).
   - **Names are storage names.** Rows, `where`, `set`, `orderBy` and cursors use the table's column names (`requestnumber`,
     `created_at`), the keys `SELECT *` returns on every target and the same SQL names as the other generated outputs.
     Authored camelCase exists only in a View's aliases.
   - **No runtime allowlist.** Every column name is quoted by the dialect (`ident`); an unknown one is a database error, never
     SQL. Column names, value types, operators, `order`, ids, lock values, writable columns and `orderBy` are enforced
     by the generated TypeScript types only; every value is a bound parameter, so the worst outcome of breaking a type is a
     database error or a wrong result inside the caller's rows. The runtime refuses what a type cannot guarantee: `limit`
     outside 1 to 500 (printed into the SQL), an `undefined` write value (a driver binds NULL), any write to a publishing Schema,
     and a write that names a system column (`id`, `version`, `created_at`, `updated_at`, `author_id`, `status`, `_rid`, compared without
     case because SQLite folds it) or the scope column.
   - **Reads are `SELECT r.*`.** Only the date-time and date columns are replaced by the dialect's wire-form templates
     (`wireTimestamp`/`wireDate`, the definition the generator also uses), listed after `*` under the same name: a result row
     keeps the last of two same-named columns on bun:sqlite, D1, Bun.SQL and postgres.js (checked on all four). Core never
     reads back the scope column and `_rid` is storage's, so the runtime deletes those two keys from each row (a column list
     would be a per-column table). A write returns `RETURNING *` plus the same replacements.
   - **Date-times, dates, booleans and JSON.** `ts`/`d` columns encode inputs with `kernel/scalars.ts` and the dialect's cast;
     a boolean goes through `bool`, and a non-Date object or array through `json` plus its cast (so the generated type
     narrows a JSON column's input to `object`).
   - **`orderBy` is indexed and NOT NULL, in the types.** The generated `order` type lists `id` and the indexed
     columns (the first, or the one after the scope column) that are NOT NULL; the keyset cursor has no NULL handling and
     ties break on `id`. NOT NULL means: a system column, or required and not nullable in the Schema. It is a
     database guarantee: Core's `initialStorageSql` (both dialects, one rule `notNullColumns`) declares NOT NULL for every field an
     `operational` Schema requires and does not allow null. A `publishing` Schema's drafts may be incomplete, so none of its fields
     qualify for `orderBy`. Convergence at boot (replaced by 0.2) keeps its own DDL and does not alter existing columns.
   - **Insert ids are Core's.** `writePolicy` fills `id` with `newId`; Core's lowering renders that as SQL
     (`lower(hex(randomblob(16)))`, `replace(gen_random_uuid()::text, '-', '')`). The generator prints that same lowering once
     (`coreNewId`) into the `Rules`, and the Store inserts it as the id expression: same format, same source as a
     Procedure's INSERT, no id code in the runtime.
   - **A unique clash is `CONFLICT`.** Each driver's `procedure()` maps the engine's unique-index violation (`dialect.unique`)
     to `ContractError("CONFLICT")` with the native error as `cause`, as Core does. This also changes generated Procedures,
     which used to rethrow it natively.
6. **The Store does not check `requires`.** As in 0.2, `requires` gates Views and Procedures; a custom handler runs
   after its Procedure's gate. The Store applies row rules only.

## Consequences

- Each concern has one home; the Better Auth adapter keeps only Better Auth's own semantics (OR grouping, joins).
- Store runtime (store, binds, where and contracts, bundled with esbuild and minified, one harness): 7,610 bytes before,
  6,309 (gzip 3,086) after the second prototype, then 831 bytes (gzip 356) fewer once the checks the generated types already state were removed (same esbuild command: 6,289 to 5,458, gzip 3,080 to 2,724). Per Schema fact: 519-827 bytes (gzip 244-354) before, 2-54 now (22-71); the shared rules
  are 396-413 bytes once. `generated.ts` for the purchase and Store fixtures: 31.3 KB to 29.7 KB.
- Warm cost on bun:sqlite over the same SQL run by hand (p50, 6,000 interleaved pairs): `findById` +0.17 µs, `find` (50 rows,
  including two `delete`s per row) +3.2 µs, 3-condition `find` +5.0 µs, cursor page +5 µs, `count` +0.6 µs, `insert` +9 µs, `update`
  +5 µs. Exploratory, not a formal run (AGENTS.md).
- The package ceiling is 128 KiB unpacked and 48 KiB packed so `.d.ts` files keep their documentation for coding agents.
- Core tests need Node >= 22.22 (`node:sqlite` `columns()`); `.nvmrc` pins 22.22.3, and Next's tests pass on it and on 22.14.
- Rows of a table with a `geo` field carry its two physical columns (`*`); the row type lists `<field>_lat`/`<field>_lng`.
- `SELECT *` order and the rule that the last of two same-named columns wins are driver behavior; the Store scenarios
  pin them on every target.
