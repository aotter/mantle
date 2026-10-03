# ADR-0034: Store is authored as SQL and compiled to IR by the CLI

**Status:** Accepted for 0.2.0 (#1188), after the spike (#1203). Amends ADR-0030, ADR-0032 decisions 1, 2, 3, 4, 5, 10 and 13, and ADR-0033.

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
| Schema | — | `checks: [<boolean expression>]`, `sequences: [<name>]`, `search: [<field>]`, fields with `format: geo` |

`handler: { ref }` is unchanged. The IR stays internal to the plan. It is public only through `ctx.store.select` and `ctx.store.write` in handler code, which keep ADR-0030's JSON shape; a manifest never contains IR.

### 2. The dialect: SQLite semantics in the syntax PostgreSQL and SQLite share

- **Semantics and functions are SQLite's, limited to what D1 authorizes.** The compiler carries the allowlist measured on D1, and CI checks it against local D1.
- **Syntax is a chosen subset** of what PostgreSQL and SQLite share, parsed by `libpg-query`. It covers what applications commonly do (checked against MongoDB's everyday operations and the repository's examples) and stops where a feature would be hard to control. Anything left out can be added later without breaking a manifest; removing a feature would break one. SQLite-only spellings the parser rejects have shared equivalents: `IS DISTINCT FROM` for `IS NOT`, `ON CONFLICT` for `INSERT OR …`.

  | Area | Supported in 0.2.0 | Rule |
  |---|---|---|
  | Expressions | columns, aliases, literals, arithmetic, `\|\|`, `CASE`, `COALESCE`, `NULLIF`, `CAST` | `SELECT *` and `RETURNING *` expand to the declared fields, never to scope or system columns. A `CAST` to a Mantle type is rewritten by the compiler. SQLite truncates where PostgreSQL rounds, so `CAST(x AS int)` of anything but an integer literal is refused (`SQL_TYPE`, in the validation the runtime shares) and asks for `round(x)` (a tie rounds away from zero, as PostgreSQL's `numeric` does; PostgreSQL's `float8` rounds half to even); `CAST(x AS bool)` becomes `x <> 0` for a number and PostgreSQL's spellings (`t`, `true`, `yes`, `on`, `1`) for text, since `'false' <> 0` is true in SQLite |
  | Conditions | comparison, `AND`/`OR`/`NOT`, `BETWEEN`, `IS [NOT] NULL`, `IS DISTINCT FROM`, `IN (list \| subquery)`, `[NOT] EXISTS`, `LIKE … ESCAPE` | an input array in `IN` lowers to `json_each` and binds once. `LIKE` is case-insensitive in SQLite, unlike PostgreSQL; the diagnostics say so |
  | Relations | one Schema, `INNER`/`LEFT JOIN … ON` (self-joins included), a subquery in `FROM`, `json_each(<input or column>)` | the one comma join allowed is `t, json_each(t.col)` (MongoDB's `$unwind`) |
  | Subqueries | scalar and correlated | — |
  | Aggregation | `count`, `sum`, `min`, `max`, `avg`, `count(DISTINCT)`, `json_group_array([DISTINCT])`, `json_group_object`, `GROUP BY`, `HAVING` | a selected column must be grouped or aggregated |
  | Windows | `row_number()`, `rank()`, `sum`/`count … OVER (PARTITION BY … ORDER BY …)`, in Views only | no frame clause; for `row_number()` only, the compiler appends `id` to the window's `ORDER BY`. `rank()` and running aggregates keep PostgreSQL's peer semantics, which an appended key would break |
  | Order and paging | `ORDER BY … [NULLS FIRST \| LAST]`, `LIMIT`, `DISTINCT`, cursors | the compiler appends `id` as the final sort key (the group key under `GROUP BY`); `LIMIT` needs an `ORDER BY`; a nullable sort key states its NULL position; `DISTINCT` with `ORDER BY` is refused, since the appended key would change what is distinct; ordering a subquery in `FROM` needs that subquery to output `id` |
  | JSON | `->>`, `json_extract`, `json_set`, `json_insert`, `json_remove`, `json_array_length` | a JSON result carries its declared type; `->` is refused |
  | Writes | `INSERT … VALUES` (one row), `INSERT … SELECT`, `UPDATE … SET <expr> WHERE`, `DELETE … WHERE`, `RETURNING <columns>`, `ON CONFLICT (…) DO NOTHING \| DO UPDATE … EXCLUDED` | see decision 8 for what a write may name; an `INSERT` on a scoped Schema names no `id`, the compiler generates it. `ON CONFLICT` is a set op, and on a scoped Schema its conflict target includes the scope field |
  | Programs | several statements, one batch | statements pass values only through tables |
  | Time | `now()`, `date_trunc('hour' \| 'day' \| 'week' \| 'month' \| 'year', ts)`, `extract(year \| month \| day \| dow \| hour FROM ts)`, `ts ± interval` in seconds, minutes or hours, `ts - ts` | `date_trunc` and `extract` compute in the site time zone. `ts - ts` is microseconds. Display formatting belongs to the client |
  | Search and places | `search()`, `search_rank()`, `near()`, `distance()` | decision 9 |
  | Mantle | `input.<name>`, `auth.uid()`, `auth.role()`, `nextval()`, `numeric(p, s)` columns | below |

  **Deferred** (each is additive): `UNION ALL`, `UNION`, `INTERSECT`, `EXCEPT`; non-recursive CTEs (a subquery in `FROM` covers them); aggregate `FILTER` (`sum(CASE …)` covers it); `string_agg`; `$pull`-style array rebuilds; calendar `interval` units and `timezone()` with any zone but the site's; arithmetic rewriting for `numeric`; before hooks on set ops; a cursor over `distance()`.

  **Refused in 0.2.0:** `RIGHT`/`FULL JOIN` (rewrite as `LEFT JOIN`); `CROSS JOIN` and comma joins other than `json_each`, where one forgotten condition is a Cartesian product; recursive CTEs, whose work has no bound; `LATERAL`, `NATURAL`, `USING`, `GROUPING SETS`; `UPDATE … FROM` and `DELETE … USING`, where SQLite picks an arbitrary row when several match (a correlated subquery in `SET` covers them); multi-row `VALUES` (`json_each(input.items)` covers it); window frames.
- **References.** `input.<name>` reads a declared input property, as PostgreSQL's `NEW`, `OLD` and `EXCLUDED` read pseudo-relations. `auth.uid()` is the caller's application subject key and `auth.role()` its staff role (ADR-0032 decision 8). `now()` is the invocation time. Positional `$1` is refused. `input` and `auth` are reserved and cannot name a Schema or an alias. A Schema's `scope` names the same reference (`scope: { ownerId: "auth.uid()" }`), so ADR-0032's `$input.<path>`, `$ctx.user.id`, `$now` and `{ $literal }` are gone; a SQL literal is a literal.
- **Identifiers resolve case-insensitively,** as SQLite does. The parser folds unquoted identifiers to lower case, so `createdAt` and `createdat` name the same column. SQLite already refuses two tables or two columns whose names differ only by case, and `mantle validate` refuses them first. A Schema whose name is not a plain identifier is quoted: `"support-requests"`. A Schema or field named with one of the 14 keywords that SQLite rejects unquoted and the printer leaves bare is refused: `add alter autoincrement commit delete drop escape index insert nothing raise set transaction update` (measured against all 147 PostgreSQL keywords; `match` and `glob` are fine). The list belongs to `pgsql-deparser` 18.3.8 and D1's SQLite, and the spike's 1d check fails when either changes it.
- **Mantle's additions keep PostgreSQL names** where PostgreSQL has one: `nextval('<sequence>')`, `date_trunc`, `extract`. `nextval()` appears only in a one-row `VALUES`, at most once per sequence per statement.
- **`numeric(p, s)` is a storage type, not an arithmetic rewrite.** Inside SQL a `numeric(12, 2)` column is its integer count of the smallest unit (cents), so `sum`, comparison and integer arithmetic are exact, as Stripe's amounts are. Input and output convert at the boundary. An author who multiplies by a fraction writes the rounding (`round(amount * input.rate)`). Rewriting decimal arithmetic in the compiler is deferred.
- **`interval`.** `second`, `minute` and `hour` compile to a microsecond constant. `day`, `week`, `month` and `year` are calendar units in PostgreSQL (a day is 23 or 25 hours across daylight saving), so 0.2.0 refuses them, and the diagnostic tells the author to bind the boundary as an input. Refusing is better than computing a wrong time; calendar units are additive later.
- **Always refused:** `OFFSET` (cursor pagination only); DDL; transaction control; data-modifying CTEs; `SELECT … FOR UPDATE`; functions outside the allowlist; any table that is not a declared Schema, `_mantle_*` included; table-valued functions other than `json_each`; `rowid`; SQLite's own clock (`'now'`, `CURRENT_TIMESTAMP`), which bypasses `now()`; `strftime`, `date` and `unixepoch` in source, which return NULL on microsecond integers; `printf` width arguments, `zeroblob` and non-constant `randomblob` sizes, which can build values of any size; `ILIKE`; `REGEXP`, which D1 lacks. There is no `native` escape: on D1 nothing sits below SQLite, so an escape could only bypass policy.
- **No `expect` in the source.** A row op must affect exactly one row, or the batch fails with `CONFLICT`. A conditional insert (`INSERT … SELECT … WHERE`) is a set op, and writing no row is a normal result.

### 3. Only the CLI parses SQL

- `@aotter/mantle/spec` exports `compilePlan(sources)`, returning a plan or diagnostics. It is the only compiler. The `mantle` CLI calls it, and so do the plugin's Cloud helper scripts: they load it from the project's installed `@aotter/mantle` with `createRequire`, as they already load the project's `esbuild`, and refuse to run when its version is not the Core version Cloud pinned (ADR-0031). The plugin bundles no parser. `compilePlan`'s signature is the stable contract between plugin and Core.
- No Worker parses SQL. Cloud's Control receives the plan, with the SQL source and its hash, and validates the IR in plain JavaScript: structure, Schema references and compatibility with the pinned Core. A tenant Worker executes the IR.
- Coding agents compile: the Claude Code CLI, desktop and cloud sessions, Cowork, and Codex local and remote all have a working directory and Node. A chat assistant operates a service through the Cloud MCP and does not build one.
- If a browser ever compiles (the Builder), it dynamic-imports the same `libpg-query`; a page that does not compile never loads it.
- **The IR is the parser's own AST.** It is `libpg-query`'s parse tree for the subset, with source locations stripped and each relation tagged `table` or `cte`. Mantle designs no node types. The plan records the PostgreSQL grammar version (`180004`), and the runtime refuses any other, since the AST changes between PostgreSQL majors; `libpg-query`, `@pgsql/types` and the printer are pinned to one major.
- **Validation is an exact allowlist** of node types and of the keys each may carry, shared by the CLI and the runtime. An unknown node or key is refused, never skipped: a printer that skipped keys would silently drop `OFFSET`, `WITH` or `FOR UPDATE`. Diagnostics are produced in the CLI before locations are stripped.
- **The printer is `pgsql-deparser`** (MIT, pure TypeScript, no WASM), subclassed in four places: `ParamRef` (numbered binds `?n`), `TypeCast` (`CAST(… AS …)` instead of `::`), `A_Const` (plain SQL string literals instead of `E'…'`) and `A_Expr` (`x LIKE p ESCAPE e` parses to `like_escape(p, e)`, which SQLite lacks). The `ParamRef` override is a correctness fix: SQLite reads `$n` as a named parameter numbered by first appearance, so binds would shift silently. Four AST rewrites also precede printing: the `pg_catalog.` prefix and SQL-syntax calls, `btrim` to `trim`, `= ANY (subquery)` to `IN`, and type names. The rest of the subset prints as valid SQLite, and each allowlisted node type has a conformance case on local D1. Eight changes are under "about a dozen", so Kysely's SQLite compiler is not needed.
- **Handler-built queries join the same path.** `ctx.store.select` and `ctx.store.write` keep ADR-0030's JSON shape; a converter turns it into the same AST, which then passes the same validation and policy.
- Measured on a prototype over the six programs of the conformance cases: runtime validation 127 lines, policy 97, printer 7 on top of `pgsql-deparser` (43 KB gzipped), no cross-owner leak.

### 4. Row ops, set ops and hooks (amends ADR-0032 decisions 2 and 3)

- **Classification.** An `UPDATE` or `DELETE` whose top-level `WHERE` conjunction contains `id = <scalar>` is a row op, and so is an `INSERT … VALUES` of one row, except that one row of `VALUES` with `ON CONFLICT` is a set op (a `DO NOTHING` that hits the conflict must not fail with `CONFLICT`). Every other write is a set op. A row op with a `version = input.<name>` conjunct is locked (ADR-0022). Classification now decides only two things: `Procedure.target` inference, and whether writing no row is a `CONFLICT`.
- **Before hooks take row ops only.** A set op on a Schema with a `before_*` Trigger for that operation is refused, as ADR-0032 decision 2 already says, and so is a set op on a Schema whose lifecycle is `publishing`. After hooks no longer refuse set ops.
- **One after-hook call per statement and Trigger.** A hook receives `ctx.cause.rows`, a non-empty array (`[Row, ...Row[]]`) whose rows always carry `id` and `version`: for a hooked target the compiler adds hidden `_mantle_id` and `_mantle_version` columns and the executor strips them before the hook sees the rows. `ctx.cause.id` is stable per (statement, hook) across retries. Rows come in no particular order and an upsert may repeat an id, so a handler is idempotent per row. A statement that writes no row calls no hook. Calling once per row is rejected: 500 rows would be 500 subrequests, past Cloud's limit.
- **After hooks** read the statement's `RETURNING` rows, which the compiler adds when the target has an after hook, and run after the commit, as ADR-0032 decision 3 says.

> **Amendment (2026-10-01, site trial):** The hook's rows and the statement's result are separate. The compiler adds the whole readable row to `RETURNING` under hidden `_mantle_h_` columns whatever the author's own `RETURNING` lists; the runner strips them from the result and hands them to the hook, decoded as `ctx.store.select` returns an entry (declared names, `createdAt`/`updatedAt` as ISO date-times). Before, an author's `RETURNING id, status` was all the hook saw, so the same hook got a different row from Admin, from a Store write and from a Procedure, against decision 3's "the row and version at commit".
- **Before hooks** read the one row first and run on it. The statement then carries the version the hook saw (`AND version = ?`), so a change between the hook and the commit is `CONFLICT`. This is today's OCC path. A before hook's `ctx.cause.rows` holds that one row. When the row is not visible (scope, TTL or published-only), the operation fails with `CONFLICT` and the hook is not called, so a hook cannot probe for another owner's row.
- A snapshot guard that would let before hooks cover set ops (pre-read, then recompute inside the batch and abort on any difference) is deferred. Review found it the costliest mechanism here: it needs read and write set analysis per statement, and a `SET` that reads its own target defeats it.
- `last_insert_rowid()` is refused everywhere.
- **Counting** uses SQLite's `changes()` inside the batch, not D1's `meta.changes`, which includes rows that triggers wrote (5 for a one-row `UPDATE` on a searchable row), so it cannot be used. Count checks fail with `CONFLICT op=<k>`, so `conflict.opIndex` becomes exact (amends ADR-0032 decision 1).
- ADR-0032 decision 3's before-hook rules stand: read-only, fail closed, committed data only, OCC between the hook and the commit.
- `mantle-update` rewrites `ctx.event.entry` into a loop over `ctx.cause.rows`, never into `rows[0]`.

### 5. Storage (amends ADR-0033)

- **Types are encoded so D1 computes them exactly:**
  - `timestamptz` (`format: date-time`) is an integer of microseconds since the epoch, exact until the year 2255;
  - `date` (`format: date`) is an integer count of days;
  - `numeric(p, s)` is an integer scaled by 10^s, with `p` at most 15 because D1 rounds past 2^53 (decision 2).

  Mantle's native timestamps move from milliseconds to microseconds.
- **Every parameter is bound through a `CAST` to its declared input type,** so integer arithmetic gives the same result on D1, which binds numbers as floats, and on every other driver.
- **Schema tables Mantle creates are `STRICT`.** An existing table is not rebuilt. Each carries `_rid INTEGER PRIMARY KEY`, an alias of the rowid, and `id TEXT NOT NULL UNIQUE`: the FTS5 and R*Tree tables key on the rowid, and a rowid that no `INTEGER PRIMARY KEY` aliases may change on `VACUUM`. `_rid` is not addressable.
- **`checks` and foreign keys are enforced by triggers** that storage convergence creates, because SQLite cannot add a `CHECK` or a foreign key to an existing table. The triggers only `RAISE`, except the ones that keep `_mantle_fts_*` and `_mantle_geo_*` in step (decision 9), which write only those system tables. Foreign keys are `RESTRICT` only: storage never creates `CASCADE` or `SET NULL`, whose writes would not run Mantle hooks. A `check` reads only the row's own columns and pure functions, never a subquery.
- **Sequences and time zones use system tables.** `nextval()` increments `_mantle_sequences` with `UPDATE … RETURNING`, and a later statement in the same batch reads the value back. `date_trunc` and `extract` join `_mantle_tz`, the site time zone's UTC-offset transitions, so daylight-saving zones compute correctly. Transitions match `Intl` on every measured instant. Where local time repeats, each pass of the repeated hour truncates to its own hour start; where a zone skips half an hour (Lord Howe), truncating to the hour has no single answer. Neither was compared with PostgreSQL, so parity is not claimed for them. The site time zone is a site setting, and the runtime generates its transitions with `Intl.DateTimeFormat`, whose time zone data ships with workerd and Node, when the setting changes or on deploy; no time zone library is bundled.

### 6. One executor, one test line (amends ADR-0032 decisions 4 and 13)

- **One executor.** `SqliteStoreExecutor` is the only executor, over a `DatabaseDriver`: D1, with Bun and libSQL experimental. `MemoryStoreExecutor`, the in-memory test fake and the IndexedDB repositories are removed, and so is `ViewQueryExecutor`, since every View compiles to IR.
- **`/indexeddb` is removed, with no browser driver in 0.2.0.** Nothing uses `@aotter/mantle-indexeddb` today, and the Builder's preview moves to Cloud. A browser-only application that needs one later gets an additive subpath: a SQLite-in-WASM driver under `SqliteStoreExecutor`, not a new executor.
- **One test line.** `@aotter/mantle/testing` stays engine-free, `runStorageConformance({ create })`, and each driver runs it on its own engine.
  - D1 runs it on local D1 inside workerd (`@cloudflare/vitest-pool-workers`), locally and in CI alike; 500 cases take about 3.5 s. Code that runs in a Worker is tested there, while spec and CLI tests stay in Node, where `libpg-query` runs.
  - One case prepares every function on the compiler's allowlist against local D1, so CI fails when D1 changes the list.
  - D1 test helpers, if published, live at `@aotter/mantle/cloudflare/testing`, with `wrangler` as an optional peer.
  - `node:sqlite` is not used, and the `sqlite-d1.ts` fake is removed, because its `batch` runs statements without a transaction.
  - Ceiling: workerd's Linux binary needs glibc 2.35 and has no musl build, so the storage tests do not run on Alpine.

### 7. Cloud validates the plan (amends ADR-0032 decision 10)

The platform-verified facts become the **Cloud-validated plan**, the pinned Core, storage matching the plan and the fingerprint handshake. The runtime's Store injects scope, TTL, published-only and OCC at execution whatever compiled the IR, and a plan can express nothing its SQL author could not, provided the runtime enforces decision 8 on every IR it compiles, handler-built IR included. So this loses no guarantee.

That the IR matches its SQL source is **service-reported**: the plan carries the source's hash, and the compiler is the pinned Core. Host protocol 3 uploads the plan.

`verifyPlan(plan, storage)` in `@aotter/mantle` is that validation: boot's own checks of the plan (version, fingerprint, dialect, guard and hook targets) and every View and inline Procedure through the storage's dialect, its `restrict` and the policy rewrite, with no database and no SQL parser. It returns the diagnostics, each with the program's path; handlers and schedule wiring stay the host's.

What `verifyPlan` proves is that a plan reads and writes only through the policy rewrite and refuses what boot would refuse. It does not bound the CPU a plan's request costs: a JSON Schema `pattern` runs a backtracking JavaScript regex, and the pattern checks catch the shapes that backtrack catastrophically by accident, not every slow regex an author can write. A host that runs untrusted plans bounds CPU per request instead (Cloud dispatches each tenant request with a CPU limit), so a slow plan stalls only its own requests.

### 8. Policy injection

- **Every Schema reference is wrapped.** The compiler has one function that prints a Schema table's name, and it always prints `(SELECT <declared columns> FROM "t" WHERE <scope> AND <ttl> AND <published>) AS <alias>`. Joins, subqueries, set-op branches and window inputs therefore see only visible rows, and a `LEFT JOIN` stays a left join. SQLite flattens the wrapper, so the index the scope leads is still used; RIGHT JOIN would materialize, one more reason it is refused.
- **`UPDATE` and `DELETE` targets** cannot be subqueries in SQLite, so the same predicate is ANDed into their `WHERE`. `ON CONFLICT DO UPDATE` gets it in the `DO UPDATE … WHERE`, TTL included, so a conflict cannot overwrite another owner's row or revive an expired one.
- **A write may not name** the scope field or a system column (`id` on update, `version`, `status`, `authorId`, timestamps) in an `INSERT` column list, an `UPDATE … SET` or a `DO UPDATE SET`. The compiler fills them. On a scoped Schema the compiler also generates `id` on insert, because a caller-chosen id collides with another owner's row and reveals it; a retry-safe insert there is an upsert on a unique key that includes the scope field. The refusal applies per Schema, to that Schema's own scope field. Changing `status` belongs to the lifecycle rules. Moving a row to another owner is impossible by construction.
- **Name resolution is checked at run time too.** The CLI tags each relation `table` or `cte`. The runtime refuses an IR whose `cte` reference is not defined in scope or carries a Schema's name, since SQLite would resolve it to the unwrapped table. The same check runs on IR built by handler code.
- **Constraints do not leak across owners.** On a scoped Schema a unique constraint includes the scope field, so a collision can only be with the caller's own rows. A foreign key between two scoped Schemas requires the same owner (`parent.owner = NEW.owner`), and a foreign key from an unscoped Schema to a scoped one is refused. Otherwise an insert could pin another owner's row or reveal that it exists.
- **Published-only does not follow foreign keys.** A public View that joins a Schema without `publishing` must also join that row to a `publishing` Schema by an explicit condition, or `mantle validate` refuses it.
- **Binds are numbered** (`?1`, `?2`), so the caller and `now()` bind once however many references a statement wraps.
- `runtime.store` is trusted: no scope, TTL still applies (ADR-0030).
- **One conformance case guards the rule.** It lists every relation position the IR has (`from`, joins, subqueries, `json_each`, window input, `INSERT … SELECT`, update and delete targets, `DO UPDATE`, search, near) in a `Record` checked with `satisfies` against the IR's position union, seeds a second owner's rows, including an expired and an unpublished one, and asserts none appear or change. A new position without a probe fails typecheck. The parser's AST does not say which keys hold a relation, so the position union is a hand-kept list, bound three ways: each edge is checked against `@pgsql/types` keys, `ALL_EDGES_REACHED` fails when an edge has no position, and the policy pass fails closed on a relation reached through an edge it cannot name.

### 9. Search and places

- **Full-text search.** A Schema declares `search: [<field>, …]`. Storage keeps `_mantle_fts_<schema>`, an FTS5 external-content table with the `trigram` tokenizer, so Chinese substrings match, in step through triggers, and builds it with FTS5's `rebuild` when `search` is added. `search(t, input.q)` lowers to `t.rowid IN (SELECT rowid FROM _mantle_fts_<schema> WHERE _mantle_fts_<schema> = ?)`, so policy still applies to `t`; the printed form is `fts = q` because PostgreSQL's grammar has no `MATCH`, and FTS5 gives the same results. The policy wrapper also outputs `rowid AS _rid`. `search_rank(t)` orders by `bm25`, taking the query of the `search(t, q)` in the same `SELECT`. The query binds as a quoted phrase, never as FTS5 syntax. A query shorter than three characters, which trigram cannot match, lowers to `LIKE` over the same fields. Admin's `searchFields` uses `search()` when the Schema declares it.
- **Places.** A field with `format: geo` holds `{ lat, lng }` as two `REAL` columns, and storage keeps `_mantle_geo_<schema>`, an R*Tree of the points, in step through triggers. `near(t.f, lat, lng, meters)` binds a bounding box the runtime computes from the radius, then filters by haversine distance. `distance(t.f, lat, lng)` is that distance in meters, for `SELECT` and `ORDER BY`. `near()` requires a literal radius, at most 50 km (coordinates may be inputs or literals, since the bounding box is bound at run time), and a query ordered by `distance()` a `LIMIT` of at most 100: nearby search returns the closest K, with no cursor. A box that crosses the antimeridian or a pole is refused. Polygon containment is not provided.
- Measured on local D1: FTS5 with `trigram` (a three-character Chinese query matches, a two-character one does not), external content kept by a trigger, `bm25` and `snippet`, R*Tree, and `radians`, `sin`, `cos`, `asin`, `sqrt` and `atan2` on the allowlist. Production D1 passed the same probes on 2026-09-29 (FTS5 trigram, R*Tree, the math functions, `RAISE(IGNORE)` with `changes()`; `next/spike/production-probe.sql`). Local D1 needs workerd 1.20260903.1 or later to create an R*Tree.

## Conformance cases

1. The requisition program: a `CASE` value, `RETURNING`, a `WHERE id AND cond` precondition that fails with `CONFLICT`, and a conditional `INSERT … SELECT … WHERE` that writes zero or one row and calls an after hook only when it writes.
2. Stock: `SET stock = stock - input.qty` with `checks: ["stock >= 0"]`, where oversell fails through the check trigger.
3. A report View with a join, `GROUP BY`/`HAVING` and a cursor, where scope and TTL are injected into every joined Schema.
4. Before hooks: a row op whose row changes between the hook and the commit fails with `CONFLICT`; a set op on a Schema with a before hook is refused.
5. The dialect: an unknown AST key, `OFFSET`, a function outside the allowlist, `$1`, `RIGHT JOIN`, `UPDATE … FROM`, `CURRENT_TIMESTAMP`, an undeclared table, a `cte` reference carrying a Schema's name and `_mantle_*` are refused with a position in the source SQL.
6. Types: `? / 2` with an integer input, `sum` over a `numeric(12, 2)` column, a microsecond timestamp compared with `now() - interval '36 hours'`, and `date_trunc('day', ts)` on a daylight-saving day in the site time zone give PostgreSQL's results on D1 (outside the repeated and skipped hours of decision 5); a non-literal `CAST(x AS int)` is refused and `round(x)` matches PostgreSQL; `interval '1 day'` is refused.
7. Policy: the relation-position probe of decision 8, on local D1.
8. Search and places: a trigram match and a two-character fallback, a phrase containing FTS5 operators matched literally, another owner's rows absent from `search()` and `near()`, and `near()` returning the closest K in order.

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
- **Support as much of the shared syntax as possible.** Rejected in review: every feature is a policy position, a guard case and a diagnostic to keep correct, and a removal breaks manifests while an addition does not. The subset starts from what applications do and grows by addition.
- **Inject policy through CTEs that shadow table names, or through persistent views reading a caller row written first in the batch.** Rejected: an `UPDATE` target does not resolve to a CTE, so writes would need a second mechanism, and a view reading a context row turns every read into a write and fails open when the context row is missing.
- **Calling hooks once per row, or rewriting a before-hooked statement to the pre-read ids.** Rejected: the first exceeds subrequest limits; the second reproduced two corruptions on local D1 (a phantom between statements, and an expression reading another table that changed).
- **A Mantle-designed IR printed by a hand-written printer, or Kysely operation nodes.** Rejected: the parser's AST already is a complete, typed IR, and `pgsql-deparser` prints it. Converting to Kysely nodes took more code than the hand-written printer, and Kysely's node kinds are internal to a 0.x library, so they cannot be a stored plan format.

## How to apply

1. Spike, in `next/`:
   - print every allowlisted node type with `pgsql-deparser` and run it on local D1, counting the overrides needed;
   - run the conformance programs on local D1 in workerd;
   - measure how helpful the diagnostics are to an agent;
   - prove the `CAST` rule, the type encodings and `date_trunc` across daylight saving.
2. Settle #1196 from the spike's result.
3. The diagnostic codes are `SQL_SYNTAX`, `SQL_UNSUPPORTED`, `SQL_FUNCTION`, `SQL_RELATION`, `SQL_COLUMN`, `SQL_WRITE`, `SQL_SHAPE` and `SQL_TYPE` (fixed by the spike, no warning code), and are added to ADR-0032 decision 5's table.
4. Everything here ships in 0.2.0. The additions land in the order sequences, `numeric` columns, then the site time zone: a sequence is one system table, `numeric` is a boundary codec, and the time zone needs transition data generated and kept current.

## Implementation status

Proposed.

> **Amendment (spike, #1203, 2026-09-29):** The spike's findings are folded into decisions 2 to 5, 8 and 9 and How to apply 3. Changes: the four printer overrides and four AST rewrites; the 14 measured reserved names; `row_number()`-only window key; one-row upsert as a set op; hook rows always carry `id` and `version`, invisible before-hook rows fail with `CONFLICT`; time zone parity not claimed; a non-literal `CAST` to int is refused in favor of `round(x)` (replacing the earlier warning); relation positions as a hand-kept, type-bound list; the printed form of `search`; production D1 probed.
