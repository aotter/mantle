# ADR-0034: Store is authored as SQL and compiled to IR by the CLI

**Status:** Proposed for 0.2.0 (#1188). Amends ADR-0030, ADR-0032 decisions 1, 2, 3, 4, 5, 10 and 13, and ADR-0033.

**Date:** 2026-09-29

**Related:** ADR-0030, ADR-0031, ADR-0032, ADR-0033, #1151, #1196

## Context

ADR-0032 decision 5 made the grammar the IR: an inline Procedure program and a View `select` are JSON write and read ops that #1196 implements. Business rules then asked for more of SQL: branches (`CASE`), column arithmetic, `CHECK` constraints, `RETURNING`, joins, aggregates and window functions. Each would be a node Mantle designs, documents and teaches, and for anything past a filter the result is a private query language (compare a join with an aggregate written as JSON). SQL is the query language agents know best, and it already has every one of these.

Mantle runs on D1. Measured on production D1 and on local workerd, which enforce the same function allowlist:

- SQLite is at least 3.45 (`jsonb`, `string_agg`, `concat`, `unixepoch('subsec')`), with window functions, recursive CTEs, `FULL`/`RIGHT JOIN`, `NULLS LAST`, `RETURNING`, `UPDATE … FROM`, `ON CONFLICT … DO UPDATE`, JSON, math functions, `STRICT` tables, virtual generated columns added by `ALTER`, and triggers that `RAISE(ABORT, …)`. Foreign keys are enforced by default.
- D1 authorizes functions from an allowlist (`sqlite_version`, `json_pretty`, `power`, `ceiling`, `unistr` and others are refused), binds at most 100 parameters per statement, accepts statements up to 100 KB and has no interactive transaction: a program is one `batch`, applied in order, all or nothing.
- D1 binds a JavaScript number as a floating-point value (`? / 2` with 5 is 2.5) and rounds integers past 2^53 without an error.

Four parsers were measured. `libpg-query` (the PostgreSQL parser, MIT, WASM) parsed every case. `pgsql-ast-parser` misses `IS DISTINCT FROM` and `INTERSECT`; `node-sql-parser` misses `ON CONFLICT`, window functions, `INTERSECT`, `UPDATE FROM` and `FULL JOIN`; `sql-parser-cst` covers SQLite fully but is GPL-2.0-or-later, which Mantle's Apache-2.0 package cannot ship. `libpg-query` declares a 128 MiB minimum WASM memory, which is the whole isolate limit of a Cloudflare Worker, so it cannot run in one.

## Decision

### 1. Manifests carry SQL; the plan carries IR

SQL is source and the IR is the compiled artifact, the way TypeScript is source and JavaScript is output.

| Atom | v2 in #1196 | This ADR |
|---|---|---|
| View | `spec.select` (JSON) or `spec.sql` (native) | `spec.sql`: one `SELECT` |
| Procedure | `handler: { store: [ops] }` | `handler: { sql: <statements> }`: one or more statements, applied as one batch |
| Schema | — | `checks: [<boolean expression>]`, `sequences: [<name>]` |

`handler: { ref }` is unchanged. The IR stays internal to the plan. It is public only through `ctx.store.select` and `ctx.store.write` in handler code, which keep ADR-0030's JSON shape; a manifest never contains IR.

### 2. The dialect: SQLite semantics in the syntax PostgreSQL and SQLite share

- **Semantics and functions are SQLite's, limited to what D1 authorizes.** The compiler carries the allowlist measured on D1, and CI checks it against local D1.
- **Syntax is the core the two share,** parsed by `libpg-query`: `SELECT` with joins, CTEs (recursive included), `UNION`/`INTERSECT`/`EXCEPT`, window functions, aggregates with `FILTER`, `GROUP BY`/`HAVING` and subqueries; `INSERT … VALUES | SELECT` with `ON CONFLICT (…) DO NOTHING | DO UPDATE SET … EXCLUDED.x [WHERE]`; `UPDATE … [FROM] … WHERE`; `DELETE … WHERE`; `RETURNING` on every write. SQLite-only spellings the parser rejects have shared equivalents: `IS DISTINCT FROM` for `IS NOT`, `ON CONFLICT` for `INSERT OR …`. `GLOB` is unavailable.
- **References.** `input.<name>` reads a declared input property, as PostgreSQL's `NEW`, `OLD` and `EXCLUDED` read pseudo-relations. `auth.uid()` is the caller's application subject key and `auth.role()` its staff role (ADR-0032 decision 8). `now()` is the invocation time. Positional `$1` is refused. `input` and `auth` are reserved and cannot name a Schema or an alias. A Schema's `scope` names the same reference (`scope: { ownerId: "auth.uid()" }`), so ADR-0032's `$input.<path>`, `$ctx.user.id`, `$now` and `{ $literal }` are gone; a SQL literal is a literal.
- **Identifiers resolve case-insensitively,** as SQLite does. The parser folds unquoted identifiers to lower case, so `createdAt` and `createdat` name the same column. SQLite already refuses two tables or two columns whose names differ only by case, and `mantle validate` refuses them first. A Schema whose name is not a plain identifier is quoted: `"support-requests"`.
- **Mantle's additions keep PostgreSQL names**, since SQLite has none of them: `nextval('<sequence>')` and `timezone('<zone>', ts)`. Exact decimals are a column type, `numeric(p, s)`, not a function.
- **`interval` takes exact units only:** `interval '<n> second | minute | hour'` compiles to a microsecond constant. Day, week, month and year are refused until calendar arithmetic ships with time zones, since a PostgreSQL day is a calendar day, 23 or 25 hours across daylight saving.
- **Refused at compile time:** `OFFSET` (cursor pagination only); DDL; transaction control; data-modifying CTEs; `SELECT … FOR UPDATE`; functions outside the allowlist; any table that is not a declared Schema, `_mantle_*` included. There is no `native` escape: on D1 nothing sits below SQLite, so an escape could only bypass policy.
- **No `expect` in the source.** A row op must affect exactly one row, or the batch fails with `CONFLICT`. A conditional insert (`INSERT … SELECT … WHERE`) is a set op, and writing no row is a normal result.

### 3. Only the CLI parses SQL

- `@aotter/mantle/spec` exports `compilePlan(sources)`, returning a plan or diagnostics. It is the only compiler. The `mantle` CLI calls it, and so do the plugin's Cloud helper scripts: they load it from the project's installed `@aotter/mantle` with `createRequire`, as they already load the project's `esbuild`, and refuse to run when its version is not the Core version Cloud pinned (ADR-0031). The plugin bundles no parser. `compilePlan`'s signature is the stable contract between plugin and Core.
- No Worker parses SQL. Cloud's Control receives the plan, with the SQL source and its hash, and validates the IR in plain JavaScript: structure, Schema references and compatibility with the pinned Core. A tenant Worker executes the IR.
- Coding agents compile: the Claude Code CLI, desktop and cloud sessions, Cowork, and Codex local and remote all have a working directory and Node. A chat assistant operates a service through the Cloud MCP and does not build one.
- If a browser ever compiles (the Builder), it dynamic-imports the same `libpg-query`; a page that does not compile never loads it.

### 4. Row ops, set ops and hooks (amends ADR-0032 decisions 2 and 3)

- **Classification.** An `UPDATE` or `DELETE` whose top-level `WHERE` conjunction contains `id = <scalar>` is a row op, and so is an `INSERT … VALUES` of one row. Every other write is a set op. A row op with a `version = input.<name>` conjunct is locked (ADR-0022). Classification now decides only two things: `Procedure.target` inference, and whether writing no row is a `CONFLICT`.
- **Set ops are no longer refused because of hooks.** A set op on a Schema whose lifecycle is `publishing` is still refused, since drafts, publishing and published protection are per-row rules.
- **One hook call per statement and Trigger.** A hook receives `ctx.cause.rows`, a non-empty array (`[Row, ...Row[]]`). `ctx.cause.id` is stable per (statement, hook) across retries. Rows come in no particular order and an upsert may repeat an id, so a handler is idempotent per row. A statement that writes no row calls no hook. Calling once per row is rejected: 500 rows would be 500 subrequests, past Cloud's limit.
- **After hooks** read the statement's `RETURNING` rows, which the compiler adds when the target has an after hook, and run after the commit, as ADR-0032 decision 3 says.
- **Before hooks** use a snapshot guard:
  1. Before the batch, the Store reads the rows the statement will touch, together with the values it will write, using the same policy-rewritten `WHERE` and expressions.
  2. The hook runs on those rows.
  3. Inside the batch, directly before the statement, a guard computes the same SQL again and aborts with `CONFLICT op=<k>` if the result differs.

  A phantom row, a changed input to an expression, or an earlier statement writing the same table therefore rolls the batch back, and a retry sees consistent data.
- **Limits.**
  - A before-hooked statement may touch at most 500 rows (about 1 MB); more is `INPUT_VALIDATION_FAILED` naming the statement.
  - It may not use `ON CONFLICT`, or `random()`, `changes()` or `last_insert_rowid()`, whose values differ between the read and the guard.
  - `nextval()` is excluded from the snapshot comparison.
- **Counting** uses SQLite's `changes()` inside the batch, not D1's `meta.changes`, which includes rows that triggers wrote. Count and guard checks fail with `CONFLICT op=<k>`, so `conflict.opIndex` becomes exact (amends ADR-0032 decision 1).
- ADR-0032 decision 3's before-hook rules otherwise stand: read-only, fail closed, committed data only. The guard replaces OCC as the check between the hook and the commit.
- `mantle-update` rewrites `ctx.event.entry` into a loop over `ctx.cause.rows`, never into `rows[0]`.

### 5. Storage (amends ADR-0033)

- **Types are encoded so D1 computes them exactly:**
  - `timestamptz` (`format: date-time`) is an integer of microseconds since the epoch, exact until the year 2255;
  - `date` (`format: date`) is an integer count of days;
  - `numeric(p, s)` is an integer scaled by 10^s, with `p` at most 15 because D1 rounds past 2^53, and the compiler rewrites multiplication and division with PostgreSQL's rounding.

  Mantle's native timestamps move from milliseconds to microseconds.
- **Every parameter is bound through a `CAST` to its declared input type,** so integer arithmetic gives the same result on D1, which binds numbers as floats, and on every other driver.
- **Schema tables Mantle creates are `STRICT`.** An existing table is not rebuilt.
- **`checks` and foreign keys are enforced by triggers** that storage convergence creates, because SQLite cannot add a `CHECK` or a foreign key to an existing table. The triggers only `RAISE`. Foreign keys are `RESTRICT` only: storage never creates `CASCADE` or `SET NULL`, whose writes would not run Mantle hooks.
- **Sequences and time zones use system tables.** `nextval()` increments `_mantle_sequences` with `UPDATE … RETURNING`, and a later statement in the same batch reads the value back. `timezone()` joins `_mantle_tz`, the site time zone's UTC-offset transitions, so daylight-saving zones compute correctly. The site time zone is a site setting.

### 6. One executor, one test line (amends ADR-0032 decisions 4 and 13)

- **One executor.** `SqliteStoreExecutor` is the only executor, over a `DatabaseDriver`: D1, and sqlite-wasm (`@sqlite.org/sqlite-wasm`, Apache-2.0). Bun and libSQL stay experimental. `MemoryStoreExecutor`, the in-memory test fake and the IndexedDB repositories are removed, and so is `ViewQueryExecutor`, since every View compiles to IR.
- **`/browser`.** `@aotter/mantle/indexeddb` becomes `@aotter/mantle/browser`: the sqlite-wasm driver with a two-method persistence port, `load(): Promise<Uint8Array | null>` and `save(bytes): Promise<void>`, whose built-in store keeps the exported database as one IndexedDB record. `navigator.locks` keeps one writing tab. The browser package runs WASM in a browser, never in a Worker.
- **One test line.** `@aotter/mantle/testing` stays engine-free, `runStorageConformance({ create })`, and each driver runs it on its own engine.
  - D1 runs it on local D1 inside workerd (`@cloudflare/vitest-pool-workers`), locally and in CI alike; 500 cases take about 3.5 s. Code that runs in a Worker is tested there, while spec and CLI tests stay in Node, where `libpg-query` runs.
  - One case prepares every function on the compiler's allowlist against local D1, so CI fails when D1 changes the list.
  - sqlite-wasm runs it as the `/browser` driver, with foreign keys on. It does not imitate D1: the compiler enforces the allowlist, and the `CAST` rule makes D1's number binding irrelevant.
  - D1 test helpers, if published, live at `@aotter/mantle/cloudflare/testing`, with `wrangler` as an optional peer.
  - `node:sqlite` is not used, and the `sqlite-d1.ts` fake is removed, because its `batch` runs statements without a transaction.
  - Ceiling: workerd's Linux binary needs glibc 2.35 and has no musl build, so the storage tests do not run on Alpine.

### 7. Cloud validates the plan (amends ADR-0032 decision 10)

The platform-verified facts become the **Cloud-validated plan**, the pinned Core, storage matching the plan and the fingerprint handshake. The runtime's Store injects scope, TTL, published-only and OCC at execution whatever compiled the IR, and a plan can express nothing its SQL author could not, so this loses no guarantee.

That the IR matches its SQL source is **service-reported**: the plan carries the source's hash, and the compiler is the pinned Core. Host protocol 3 uploads the plan.

## Conformance cases

1. The requisition program: a `CASE` value, `RETURNING`, a `WHERE id AND cond` precondition that fails with `CONFLICT`, and a conditional `INSERT … SELECT … WHERE` that writes zero or one row and calls an after hook only when it writes.
2. Stock: `SET stock = stock - input.qty` with `checks: ["stock >= 0"]`, where oversell fails through the check trigger on D1 and on sqlite-wasm alike.
3. A report View with a join, `GROUP BY`/`HAVING` and a cursor, where scope and TTL are injected into every joined Schema.
4. Snapshot guard: a phantom row, a changed input to an expression, and an earlier statement writing the same table each abort the batch with `CONFLICT` naming the statement.
5. The dialect: `OFFSET`, a function outside the allowlist, `$1`, `interval '1 day'`, an undeclared table and `_mantle_*` are refused with a position in the source SQL.
6. Types: `? / 2` with an integer input, `numeric(12, 2)` multiplication, a microsecond timestamp compared with `now() - interval '36 hours'`, and `timezone()` across a daylight-saving boundary give the same results on D1 and sqlite-wasm.

## Consequences

- #1196's JSON program and `select` grammar, and the parser and graph rules written for them, are replaced by SQL lowering; `StoreProgram`'s rules move onto the compiled statement. The spike decides whether #1196 is rewritten or superseded.
- The 16 MiB-patched `libpg-query`, its workerd wrapper and the Control memory test proposed for parsing in Control are not needed.
- The Builder's in-browser preview (`packages/builder/src/lib/memory-storage.ts` in aotter/mantle-home) is built on ports this release removes, so its replacement must be decided before aotter/mantle-home adopts 0.2.0; the direction is a signed-in Cloud preview on the existing candidate preview.
- Admin's Developer Console draws a program from the IR: `CASE` as a branch, a `WHERE` guard as an edge, joins, checks, aggregates and `RETURNING` as nodes, anything else as SQL text.

## Alternatives

- **IR in the manifest** (#1196 as is). Its JSON Schema validates exactly and can constrain an agent's output, and nothing needs a parser. Rejected: past a filter it is a private language agents must learn, and every SQL feature becomes a node Mantle designs.
- **Parse in Control with a `libpg-query` patched to 16 MiB.** Rejected: a patched binary to rebuild on every upstream release, WASM memory that never shrinks (one 1.7 MB statement grew the heap to 221 MiB), and WASM in a Worker.
- **Another parser.** `pgsql-ast-parser` and `node-sql-parser` miss syntax this ADR needs; `sql-parser-cst` is GPL; the Rust `sqlparser` as WASM is 1 MB gzipped and misses the same SQLite-only syntax; native addons and Python's `sqlglot` complicate installing the CLI. In a CLI, WASM is the most portable form.
- **Compile policies into SQL ahead of time and ship statements.** Rejected: `ctx.store.select` in handler code is built at run time, so the runtime compiles IR anyway, and a second path would bypass the one Store.
- **A JavaScript executor or an IndexedDB-backed executor.** Rejected: once the IR is what D1 runs, either is a second SQLite.
- **A second test line on sqlite-wasm made to imitate D1, and a `prepare` check of every compiled statement in the CLI.** Rejected: local D1 in workerd is fast enough for everyday tests, so the imitation would be one more profile to keep in step with D1. The conformance suite on local D1 already catches compiler output that D1 refuses, and without the check the CLI does not depend on sqlite-wasm.
- **Calling hooks once per row, or rewriting a before-hooked statement to the pre-read ids.** Rejected: the first exceeds subrequest limits; the second reproduced two corruptions on local D1 (a phantom between statements, and an expression reading another table that changed).

## How to apply

1. Spike, in `next/`:
   - lower the six conformance programs through `libpg-query` to IR and run them on local D1 in workerd and on sqlite-wasm;
   - measure the lowering code and how helpful its diagnostics are to an agent;
   - build the snapshot guard;
   - prove the `CAST` rule and the type encodings.
2. Settle #1196 from the spike's result.
3. New diagnostic codes are fixed with the spike and added to ADR-0032 decision 5's table.
4. Everything here ships in 0.2.0. The additions land in the order sequences, `numeric`, then time zones: a sequence is one system table, `numeric` touches every arithmetic rewrite, and time zones need transition data generated and kept current.

## Implementation status

Proposed.
