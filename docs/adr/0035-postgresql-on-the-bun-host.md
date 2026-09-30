# ADR-0035: PostgreSQL on the Bun host; D1 runs a validated subset

**Status:** Proposed for 0.2.0. Amends ADR-0032 decisions 6 and 12, and ADR-0034 decisions 2, 3, 5, 6, 8 and 9.

**Date:** 2026-09-30

**Related:** ADR-0014, ADR-0032, ADR-0033, ADR-0034

## Context

0.2.0 ships one host, Cloudflare, over D1. The enterprise edition, sold with an SLA, needs a database its customers already operate, back up and monitor: PostgreSQL. ADR-0032 decision 6 made every host other than Cloudflare an example, and ADR-0034 decision 2 made the Store dialect "SQLite semantics in the syntax PostgreSQL and SQLite share". Both assumed one engine.

Manifests are already PostgreSQL-shaped: they are parsed by `libpg-query`, PostgreSQL's own parser, and ADR-0034 conformance case 6 already holds D1 to PostgreSQL's results for integer division, `numeric`, timestamps and `date_trunc`. What D1 cannot do is most of PostgreSQL. So the dialect has a natural owner: PostgreSQL is the language, and D1 runs the part of it Mantle can compile faithfully.

## Decision

### 1. Two first-class hosts, two engines

- **Cloudflare** runs on D1, as ADR-0032 and ADR-0034 describe.
- **Bun** runs every table Mantle has on **PostgreSQL**: Schema tables, the migration ledger and boot state, site config and media records, and Better Auth. No SQLite on Bun. The supported floor is PostgreSQL 16; CI runs 17.
- ChatGPT Sites stays a reference example (ADR-0032 decision 6). Mantle Cloud is not a third host: the Mantle GitHub repo plugin script delivers a service to the Cloudflare host.

### 2. Manifest SQL is PostgreSQL (amends ADR-0034 decision 2)

- A View or Procedure's SQL is PostgreSQL. On Bun it runs as PostgreSQL runs it: any expression, function, operator, join, window, CTE or type PostgreSQL accepts, in the statement kinds of decision 4.
- On Cloudflare, the ADR-0034 subset still applies, and it is what fails: `mantle generate --host cloudflare` refuses SQL outside it with a position in the source, as today. Inside the subset D1 must give PostgreSQL's results; conformance case 6 of ADR-0034 is the measure, and a construct that cannot match PostgreSQL on D1 is refused rather than approximated.
- So a manifest written for Bun may need changes to run on Cloudflare; one written for Cloudflare runs on Bun.

### 3. The host is part of the compile (amends ADR-0032 decision 12 and ADR-0034 decision 3)

- `mantle generate --host cloudflare|bun`, saved as `host` in `mantle.config.json` version 2. A config without `host` is `cloudflare`, so existing projects keep working. After `src/service.ts` exists, a changed `host` prints a `warning:` like any selection change and writes nothing.
- The plan records `host`, and it is part of the fingerprint: the SQL a plan carries differs by host. Boot refuses a plan compiled for the other host.
- Only the CLI parses SQL, on both hosts. For Cloudflare it emits the ADR-0034 IR. For Bun it emits PostgreSQL text with `input.<name>` replaced by numbered parameters and the declared types attached, after the checks of decision 4. The Worker and the Bun process never parse SQL.
- `toCloudflareCron` and its refusals run only for `cloudflare`. Bun uses the plan's POSIX expressions as written.

### 4. What the Bun host checks before running manifest SQL

- **Statement kinds.** A View is one `SELECT` (with `WITH`). A Procedure is `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `MERGE` statements, with `WITH` and `RETURNING`. Anything else is refused: DDL, `SET`/`RESET`, transaction control, `COPY`, `DO`, `CALL`, `LISTEN`/`NOTIFY`, `PREPARE`, and locking clauses in Views.
- **Relations.** Every table a statement names is a declared Schema, a CTE of the same statement, or a function in `pg_catalog`. Mantle's own tables and Better Auth's are never readable from manifest SQL.
- **References.** `input.<name>` is a declared input; `auth.uid()` and `auth.role()` are the only `auth` functions.
- Everything else is PostgreSQL's to accept or refuse, at `mantle generate --check` time against a scratch database when one is given, and otherwise at first execution.

### 5. Permissions are PostgreSQL Row Level Security (amends ADR-0034 decision 8 for Bun)

- Storage convergence enables and forces RLS on every Schema table and writes one policy set per Schema from its `scope`, publish rules and TTL. The table owner is subject to it too (`FORCE ROW LEVEL SECURITY`).
- Each Invocation runs in one transaction that first sets the caller with `SET LOCAL` (`mantle.uid`, `mantle.role`, `mantle.trusted`). `auth.uid()` and `auth.role()` are SQL functions over those settings, so manifest SQL uses them as written.
- An insert takes its owner from a column default of `auth.uid()`, and a trigger refuses a change of owner.
- The trusted Store (`runtime.store`, `system:host`) runs with `mantle.trusted`, which the policies admit; TTL visibility still applies, except in `sweepExpired`.
- Manifest SQL runs exactly as written; Mantle does not rewrite it. The relation-position probe of ADR-0034 decision 8 runs on PostgreSQL too, against RLS instead of injection.

### 6. One Store, two executors (amends ADR-0034 decision 6)

- `MantleStore` does not change: Admin, REST, MCP and handlers call `select`, `write`, `view` and `as(caller)` on both hosts.
- `StoreExecutor` gains a second implementation. `SqliteStoreExecutor` serves D1. `PostgresStoreExecutor` serves Bun: it renders the Store's structured operations to PostgreSQL, runs a View's or Procedure's compiled text, and applies each batch as one transaction under decision 5.
- One conformance suite: every case whose feature both hosts have runs on local D1 and on real PostgreSQL. Search and places have one case per host.

### 7. `StoreSelect.search` (new)

- `StoreSelect` gains `search?: string`. It matches rows whose declared `searchableFields`, or `id`, contain the text, under the caller's visibility like any `select`. Ordering stays `orderBy`.
- On D1 it uses the FTS5 trigram table of ADR-0034 decision 9. On PostgreSQL it uses a `pg_trgm` GIN index per searchable field with `ILIKE`; storage creates the extension and indexes. Both match Chinese substrings of three characters or more; a shorter query falls back to a scan on both.
- Admin's collection search box sends `search`, and no longer builds `like` conditions itself.
- The manifest key is `searchableFields` (ADR-0034 decision 9 wrote `search`; the plan stores it as `search`).

### 8. Search and places in manifest SQL (amends ADR-0034 decision 9)

- `search()`, `search_rank()`, `near()` and `distance()` are Cloudflare functions. On Bun they are refused with a message that names the native way: `pg_trgm` or `tsvector`/`@@` for text, PostGIS for places.
- A field with `format: geo` is `geography(Point, 4326)` on PostgreSQL, so PostGIS is required when a Schema has one; boot is blocked, naming the extension, when it is missing. The Store reads and writes `{ lat, lng }` on both hosts.

### 9. `@aotter/mantle/bun`

- Built on Bun's native PostgreSQL client, `Bun.SQL`, with structural types so the package needs no `@types/bun`.
- `postgresStorage(sql, options?)` is the storage adapter for `createMantle`, as `d1Storage` is on Cloudflare.
- `postgresAuthDatabase(sql)` is Better Auth's `database`: a Kysely dialect over `Bun.SQL`, because Better Auth supports `pg` natively but not `Bun.SQL`. Better Auth keeps its own transactions; each runs on a reserved connection.
- `createMantleAuth`'s own SQL (members, invitations, consents, linked accounts) runs on both engines; its integration test runs on D1 and on PostgreSQL.

### 10. The Bun preset

- `src/index.ts` is a `Bun.serve` default export. It connects with `DATABASE_URL`, registers one in-process `Bun.cron(expression, …, { tz: "UTC" })` per distinct enabled schedule expression and passes `schedules: true`. `scheduledTime` is the minute it fired, so a retry keeps its cause id; every running instance fires, and handlers deduplicate on `cause.id` as for a Cloudflare replay.
- It logs a failed background task instead of leaving an unhandled rejection, and sets `x-mantle-client-ip` from `server.requestIP`, replacing any value the client sent, as Better Auth's rate-limit identity. Behind a proxy the application edits `src/service.ts`.
- `src/service.ts` differs from Cloudflare's only in the storage and auth-database lines and that header. One-time sign-in codes are printed only when `PUBLIC_ORIGIN` is set to a loopback origin, as on Cloudflare. `.env.example` replaces `.dev.vars.example`. There is no `wrangler.jsonc`.

## Consequences

- The SQL an author writes for the enterprise edition is plain PostgreSQL, readable by any PostgreSQL DBA, and enforced by the database itself.
- Cloudflare keeps its compile-time guarantees; its subset is now defined as "what D1 runs with PostgreSQL's results".
- Core gains a second executor, a second storage convergence and RLS policy generation. The conformance suite is what keeps the two hosts honest.
- `Bun.SQL` for Better Auth is hand-written plumbing (a Kysely dialect); it goes away if Better Auth adds native `Bun.SQL` support.
- A plan is host-specific; moving a service between hosts is a recompile, not a copy.

## Alternatives

- **Mantle rewrites manifest SQL on PostgreSQL, as on D1.** One policy path for both hosts, but manifest SQL would be limited to what the rewriter understands, so not PostgreSQL. Rejected for decision 2.
- **SQLite (`bun:sqlite`) on Bun.** Simpler and identical to D1, but not what an enterprise SLA customer operates. Rejected.
- **`pg` (node-postgres) instead of `Bun.SQL`.** Better Auth supports it natively, but it adds a dependency next to Bun's own client. Rejected in favour of the native client.
- **SQLite semantics on PostgreSQL.** Emulating SQLite on PostgreSQL would make Bun behave unlike PostgreSQL. Rejected: PostgreSQL is the reference, D1 matches it or refuses.

## Open questions

- Media on Bun: `MediaStorage` over Bun's S3 client (R2, S3, MinIO). Proposed for 0.2.0; Cloudflare's R2 path is unchanged.
- One database role, or a migration role separate from the runtime role, for customers whose DBA requires it.
- `mantle-update` carries a v1 `host` (`cf`, `cloudflare`, `bun`) into v2; other v1 hosts (`chatgpt-sites`, `vercel`) are reported for manual handling.

## Conformance cases

1. The ADR-0034 cases 1–7 on real PostgreSQL, where the feature exists on both hosts.
2. RLS: the relation-position probe of ADR-0034 decision 8, on PostgreSQL; another owner's rows absent from every position; the trusted Store sees every owner but not expired rows; a changed owner refused.
3. The Bun checks of decision 4: DDL, `SET`, transaction control, `COPY`, `DO`, a Mantle or Better Auth table, an undeclared `input`, and `search()` refused with a position.
4. `StoreSelect.search` on both hosts: a three-character Chinese substring matches, a two-character one falls back, another owner's rows are absent.
5. The Bun preset boots under Bun against PostgreSQL: auth routes, REST and Admin answer; a forged loopback `Origin` gets no code; a forged `x-mantle-client-ip` is replaced; a schedule Trigger runs once per fire with a stable cause id.
