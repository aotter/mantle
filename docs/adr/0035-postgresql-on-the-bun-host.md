# ADR-0035: PostgreSQL on the Bun host; D1 runs a validated subset

**Status:** Proposed for 0.2.0. Amends ADR-0032 decisions 6 and 12, ADR-0033, and ADR-0034 decisions 2, 3, 5, 6, 7, 8 and 9.

**Date:** 2026-09-30

**Related:** ADR-0014, ADR-0032, ADR-0033, ADR-0034

## Context

0.2.0 ships one host, Cloudflare, over D1. The enterprise edition, sold with an SLA, needs a database its customers already operate, back up and monitor: PostgreSQL. ADR-0032 decision 6 made every host other than Cloudflare an example, and ADR-0034 decision 2 made the Store dialect "SQLite semantics in the syntax PostgreSQL and SQLite share". Both assumed one engine.

Manifests are already PostgreSQL-shaped: they are parsed by `libpg-query`, PostgreSQL's own parser, and ADR-0034 conformance case 6 already holds D1 to PostgreSQL's results for integer division, `numeric`, timestamps and `date_trunc`. What D1 cannot do is most of PostgreSQL. So the dialect has a natural owner: PostgreSQL is the language, and D1 runs the part of it Mantle can compile faithfully.

## Decision

### 1. Two first-class hosts, two engines

- **Cloudflare** runs on D1, as ADR-0032 and ADR-0034 describe.
- **Bun** runs every table Mantle has on **PostgreSQL**: Schema tables, the migration ledger and boot state, site config and media records, and Better Auth. No SQLite on Bun. The supported floor is PostgreSQL 17 (`MERGE … RETURNING`); CI runs 17.
- ChatGPT Sites stays a reference example (ADR-0032 decision 6). Mantle Cloud is not a third host: the Mantle GitHub repo plugin script delivers a service to the Cloudflare host.

### 2. Manifest SQL is PostgreSQL (amends ADR-0034 decision 2)

- A View or Procedure's SQL is PostgreSQL. On Bun it runs as PostgreSQL runs it: any expression, function, operator, join, window, CTE or type PostgreSQL accepts, in the statement kinds of decision 4.
- On Cloudflare, the ADR-0034 subset still applies, and it is what fails: `mantle generate --host cloudflare` refuses SQL outside it with a position in the source, as today. Inside the subset D1 must give PostgreSQL's results; conformance case 6 of ADR-0034 is the measure, and a construct that cannot match PostgreSQL on D1 is refused rather than approximated.
- So a manifest written for Bun may need changes to run on Cloudflare; one written for Cloudflare runs on Bun.

### 3. The host is part of the compile (amends ADR-0032 decision 12 and ADR-0034 decision 3)

- `mantle generate --host cloudflare|bun`, saved as `host` in `mantle.config.json` version 2. A config without `host` is `cloudflare`, so existing projects keep working. After `src/service.ts` exists, a changed `host` prints a `warning:` like any selection change and writes nothing.
- The plan records `host`, and it is part of the fingerprint: the SQL a plan carries differs by host. Boot refuses a plan compiled for the other host. Cloud Control (ADR-0034 decision 7) accepts only `host: cloudflare` plans.
- Only the CLI parses SQL, on both hosts. For Cloudflare it emits the ADR-0034 IR. For Bun it emits PostgreSQL text with `input.<name>` replaced by numbered parameters and the declared types attached, after the checks of decision 4. The Worker and the Bun process never parse SQL.
- A View's typed rows in `mantle.ts` come from the PostgreSQL parse tree by ADR-0034's rule: an output that reads a Schema field unchanged has that field's type, any other output is `unknown`. So `mantle generate` needs no database on either host.
- `toCloudflareCron` and its refusals run only for `cloudflare`. Bun uses the plan's POSIX expressions as written.

### 4. What the Bun host checks before running manifest SQL

- **Statement kinds.** A View is one `SELECT` (with `WITH`). A Procedure is `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `MERGE` statements, with `WITH` and `RETURNING`. Anything else is refused: DDL, `SET`/`RESET`, transaction control, `COPY`, `DO`, `CALL`, `LISTEN`/`NOTIFY`, `PREPARE`, and locking clauses in Views.
- **Relations.** Every relation anywhere in the parse tree (`FROM`, joins, `LATERAL`, and subqueries in the select list, `WHERE`, `HAVING` and `RETURNING`) is a declared Schema or a CTE of the same statement. Mantle's own tables and Better Auth's are never readable from manifest SQL.
- **Functions.** Functions in `pg_catalog` are allowed, except those that change session or server state or reach outside the database: `set_config`, the `pg_advisory_*` locks, `pg_read_*`/`pg_ls_*`, `lo_*`, `dblink*`, `pg_terminate_backend`/`pg_cancel_backend`, `pg_reload_conf`, `txid_*`/`pg_current_xact_id` writers, and `nextval`/`setval` on sequences Mantle does not declare. `auth.uid()` and `auth.role()` are the only `auth` functions.
- **References.** `input.<name>` is a declared input.
- Everything else is PostgreSQL's to accept or refuse, at `mantle generate --check` time against a scratch database when one is given, and otherwise at first execution.

### 5. Permissions are PostgreSQL Row Level Security (amends ADR-0034 decision 8 for Bun)

- Storage convergence enables and forces RLS on every Schema table and writes one policy set per Schema from its `scope`, publish rules and TTL. The table owner is subject to it too (`FORCE ROW LEVEL SECURITY`).
- Every executor call, an Invocation or a plain Store `select` from Admin, runs in one transaction that first sets the caller with parameterized `set_config('mantle.uid', $1, true)` (and `mantle.role`, `mantle.trusted`); a literal `SET LOCAL` would put caller data into SQL text. `auth.uid()` and `auth.role()` are SQL functions over those settings, so manifest SQL uses them as written, and manifest SQL cannot call `set_config` (decision 4).
- Boot refuses a connection whose role is a superuser or has `BYPASSRLS`, both of which skip RLS even when it is forced; it reads `pg_roles` for `current_user`.
- An insert takes its owner from a column default of `auth.uid()`, and a trigger refuses a change of owner.
- The trusted Store (`runtime.store`, `system:host`) runs with `mantle.trusted`, which the policies admit; TTL visibility still applies, except in `sweepExpired`.
- Manifest SQL runs exactly as written; Mantle does not rewrite it. The relation-position probe of ADR-0034 decision 8 runs on PostgreSQL too, against RLS instead of injection.

### 6. Storage on PostgreSQL (amends ADR-0033 and ADR-0034 decision 5)

- Convergence is ADR-0033's, in PostgreSQL DDL: Schema tables with native types (`timestamptz`, `numeric(p, s)`, `boolean`, `jsonb`, `geography`), native `CHECK` constraints and foreign keys (no triggers, since PostgreSQL can add both to an existing table), the migration ledger and boot state, the RLS policies of decision 5, and the indexes of decision 8.
- The Store's wire values are the same on both hosts. D1 stores microsecond integers, integer cents and `0`/`1`; PostgreSQL stores native types, and `PostgresStoreExecutor` decodes what `Bun.SQL` returns (`Date`, numeric and `int8` strings) to the values ADR-0034's codec gives, by each result column's type. The conformance suite's raw-bind negative controls are host-neutral.

### 7. One Store, two executors (amends ADR-0034 decision 6)

- `MantleStore` does not change: Admin, REST, MCP and handlers call `select`, `write`, `view` and `as(caller)` on both hosts.
- `StoreExecutor` gains a second implementation. `SqliteStoreExecutor` serves D1. `PostgresStoreExecutor` serves Bun: it renders the Store's structured operations to PostgreSQL, runs a View's or Procedure's compiled text, and applies each batch as one transaction under decision 5.
- One conformance suite: every case whose feature both hosts have runs on local D1 and on real PostgreSQL. Search and places have one case per host.

### 8. `StoreSelect.search` (new)

- `StoreSelect` gains `search?: string`. It matches rows whose declared `searchableFields`, or `id`, contain the text, under the caller's visibility like any `select`. Ordering stays `orderBy`.
- On D1 it uses the FTS5 trigram table of ADR-0034 decision 9. On PostgreSQL it uses a `pg_trgm` GIN index per searchable field with `ILIKE`; storage creates the extension and indexes. Both match Chinese substrings of three characters or more; a shorter query falls back to a scan on both.
- Admin's collection search box sends `search`, and no longer builds `like` conditions itself.
- The manifest key is `searchableFields` (ADR-0034 decision 9 wrote `search`; the plan stores it as `search`).

### 9. Search and places in manifest SQL (amends ADR-0034 decision 9)

- `search()`, `search_rank()`, `near()` and `distance()` are Cloudflare functions. On Bun they are refused with a message that names the native way: `pg_trgm` or `tsvector`/`@@` for text, PostGIS for places.
- A field with `format: geo` is `geography(Point, 4326)` on PostgreSQL, so PostGIS is required when a Schema has one. Creating PostGIS needs a superuser, so the customer's DBA installs it; boot is blocked, naming the extension, when it is missing. `pg_trgm` is a trusted extension that storage creates itself. The Store reads and writes `{ lat, lng }` on both hosts.

### 10. `@aotter/mantle/bun`

- Built on Bun's native PostgreSQL client, `Bun.SQL`, with structural types so the package needs no `@types/bun`.
- `postgresStorage(sql, options?)` is the storage adapter for `createMantle`, as `d1Storage` is on Cloudflare.
- `postgresAuthDatabase(sql)` is Better Auth's `database`: a Kysely dialect over `Bun.SQL`, because Better Auth supports `pg` natively but not `Bun.SQL`. Better Auth keeps its own transactions, and the dialect runs each one on one reserved connection (`sql.begin`), never spread over the pool.
- `createMantleAuth`'s remaining own SQL is SQLite today (`?` binds, `changes()`, `json_extract` in consent revocation, the bootstrap-owner `UPDATE`, the auth-schema ledger). It moves to Better Auth's own Kysely instance, which speaks both engines, continuing the move to Better Auth's API; its integration test runs on D1 and on PostgreSQL.

### 11. The Bun preset

- `src/index.ts` is a `Bun.serve` default export. It connects with `DATABASE_URL`, registers one in-process `Bun.cron(expression, …, { tz: "UTC" })` per distinct enabled schedule expression and passes `schedules: true`. `scheduledTime` is the minute it fired, so a retry keeps its cause id; every running instance fires, and handlers deduplicate on `cause.id` as for a Cloudflare replay.
- It logs a failed background task instead of leaving an unhandled rejection, and sets `x-mantle-client-ip` from `server.requestIP`, replacing any value the client sent, as Better Auth's rate-limit identity. Behind a proxy the application edits `src/service.ts`.
- `src/service.ts` differs from Cloudflare's only in the storage and auth-database lines and that header. One-time sign-in codes are printed only when `PUBLIC_ORIGIN` is set to a loopback origin, as on Cloudflare. `.env.example` replaces `.dev.vars.example`. There is no `wrangler.jsonc`.

## Consequences

- The SQL an author writes for the enterprise edition is plain PostgreSQL, readable by any PostgreSQL DBA, and enforced by the database itself.
- Cloudflare keeps its compile-time guarantees; its subset is now defined as "what D1 runs with PostgreSQL's results".
- Core gains a second executor, a second storage convergence and RLS policy generation; `createMantleAuth` loses its SQLite-only SQL. The conformance suite is what keeps the two hosts honest.
- `Bun.SQL` for Better Auth is hand-written plumbing (a Kysely dialect); it goes away if Better Auth adds native `Bun.SQL` support.
- A plan is host-specific; moving a service between hosts is a recompile, not a copy.

## Alternatives

- **Mantle rewrites manifest SQL on PostgreSQL, as on D1.** One policy path for both hosts, but manifest SQL would be limited to what the rewriter understands, so not PostgreSQL. Rejected for decision 2.
- **SQLite (`bun:sqlite`) on Bun.** Simpler and identical to D1, but not what an enterprise SLA customer operates. Rejected.
- **`pg` (node-postgres) instead of `Bun.SQL`.** Better Auth supports it natively, but it adds a dependency next to Bun's own client. Rejected in favour of the native client.
- **SQLite semantics on PostgreSQL.** Emulating SQLite on PostgreSQL would make Bun behave unlike PostgreSQL. Rejected: PostgreSQL is the reference, D1 matches it or refuses.

## Open questions

- Media on Bun: `MediaStorage` over Bun's S3 client (R2, S3, MinIO). Proposed for 0.2.0; Cloudflare's R2 path is unchanged.
- One database role that owns the tables and runs the service (with RLS forced on it), or a migration role separate from the runtime role for customers whose DBA requires it. Proposed: one role in 0.2.0, the split later.
- `mantle-update` carries a v1 `host` (`cf`, `cloudflare`, `bun`) into v2; other v1 hosts (`chatgpt-sites`, `vercel`) are reported for manual handling.

## Conformance cases

1. The ADR-0034 cases 1–7 on real PostgreSQL, where the feature exists on both hosts.
2. RLS: the relation-position probe of ADR-0034 decision 8, on PostgreSQL; another owner's rows absent from every position; the trusted Store sees every owner but not expired rows; a changed owner refused.
3. The Bun checks of decision 4: DDL, `SET`, transaction control, `COPY`, `DO`, `set_config('mantle.trusted', 'on', true)` and `set_config('role', …)`, a Mantle or Better Auth table in `FROM` and in a scalar subquery (`(SELECT email FROM "user" …)`), an undeclared `input`, and `search()` refused with a position. Boot refuses a superuser and a `BYPASSRLS` role.
4. Wire values: a timestamp, a `numeric(12, 2)` sum, an `int8` and a boolean read the same from D1 and from PostgreSQL.
5. `StoreSelect.search` on both hosts: a three-character Chinese substring matches, a two-character one falls back, another owner's rows are absent.
6. The Bun preset boots under Bun against PostgreSQL: auth routes, REST and Admin answer; a forged loopback `Origin` gets no code; a forged `x-mantle-client-ip` is replaced; a schedule Trigger runs once per fire with a stable cause id.
