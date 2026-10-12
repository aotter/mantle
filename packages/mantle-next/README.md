# Mantle (experimental replacement for Core)

Generate typed, concrete SQL functions for Bun SQLite, Bun PostgreSQL,
Cloudflare D1 and Cloudflare PostgreSQL. The compiler uses 0.2's closed v2
manifest grammar and canonical SQL policy/printers at build time. The generated
application imports portable contract primitives and official drivers only.

```sh
pnpm --dir packages/mantle run build
pnpm --dir packages/mantle-next run build
```

Outputs include `generated.ts`, `schema.sql` and direct operation entries.
Import a selected function from `views/<encoded-name>.ts` or
`procedures/<encoded-name>.ts` (default export, with its types) to exclude other
operations from the request bundle. Apply initial DDL explicitly to an
empty development database; this artifact is not a destructive migration or a
production convergence tool. Generation does no database I/O. Application code
passes driver-ready parameters, a database handle (Bun.SQL `SQL` for PostgreSQL, `bun:sqlite`
Database, D1 binding) and a verified
Caller to `views[name](db, caller, input)` or
`procedures[name](db, caller, input)`.

Validate untrusted input before calling queries and redact native errors at application
transports. The [query contract](../../docs/next/contract.md#revised-query-responsibility-decision-2026-10-11)
defines driver-ready inputs, native results, date-time/date wire forms and failure handling.

For transports, `paged/views/<name>.ts` returns `{ rows, nextCursor? }` with keyset paging and
`validation/<kind>/<name>.ts` checks input against the declared JSON Schema subset; the
[surface deltas](../../docs/next/surfaces.md) define the REST/MCP wire contract.
The same directly imported paging module is emitted for a proved internal View,
without adding a public route/tool. It runs one native SELECT per page, checking
the compiler-proved scalar key tuple and removing hidden keys. Schema tuples
need matching indexed order after fixed equality prefixes; complete groups and
singleton joins are also supported. Grouping still scans/aggregates its native
source; inspect EXPLAIN and source indexes for the actual workload. Unsupported
internal SQL retains its bare module instead of failing generation.

Every Schema is also a typed **Store** collection, in the shape of a document-database driver:
`store(db, caller).collection("purchase_requests")` with `findById`, `find` (AND-only `where`, keyset `cursor`), `first`,
`count`, `insert(values)`, OCC `update(id, set, { lock })` and `delete(id, { lock })`. Rows, `where`, `set` and `orderBy` use the
table's storage column names, lower-case (`requestnumber`, `created_at`), the keys a generated View returns; the generated types
state column names, value types and the writable columns, and the Store enforces the Schema's row rules (scope, TTL, version) but
**not** a View's or Procedure's `requires`: authorize before calling it. Design, limits and what the runtime still refuses are in
[ADR-0045](../../docs/adr/0045-next-runtime-core.md).

A Store-only purchase Worker retains 1,450 gzip bytes of generated operations (Bun 1.3.14, minified); the existing bound operation API stays intact.

`find({ search: "text" })` and `first({ search: "text" })` match an exact id or
the Schema's `searchableFields`. Search is trimmed, must be non-empty and cannot contain NUL; it
combines with `where`, scope, TTL and publication rules. SQLite/D1 use the
generated FTS5 trigram index with maintenance triggers (queries shorter than
three characters use LIKE); PostgreSQL uses ILIKE without requiring an extension.
`%`, `_`, quotes and FTS operators are literal text. Schemas without search fields
match id only. Non-ASCII case folding follows the dialect: SQLite/D1 FTS5
trigram folds searchable text for queries of three or more characters, while
shorter SQLite/D1 LIKE queries fold ASCII only; PostgreSQL ILIKE follows the
database locale/collation. These are the same native differences as 0.2.
Generated Views reuse Core's `mantle.search(alias, input.q)` and
`mantle.search_rank(alias)`; ranking requires search on the same alias/query.
Rank-ordered exposed Views still need supported keyset ordering; use an internal
View for arbitrary rank ordering. Applying changed search DDL remains the app's
migration responsibility; no request runs DDL or rebuilds indexes.

## Publishing

Schemas default to `lifecycle: operational`. Opt-in `lifecycle: publishing` adds status
(`draft` default, `published`, `archived`), nullable `published_at` and a scope-aware
`(published_at, id)` index; `published_at` is selectable in Views and orders Store `find`
(`NULLS LAST`). Generated `<table>.publish`, `.unpublish` and `.archive` Procedures take
`{ id, expectedVersion }`, gate staff/system callers and run one atomic UPDATE; a failed guard is
`CONFLICT`. Store writes cannot set status or `published_at`. Public Views see published rows only;
other reads expose drafts only to staff or system callers.

## Ref Procedures

A Procedure with a `ref` handler generates a typed `Handlers` interface. `mantle generate` lists the
handlers to implement; pass them at `store(db, caller, { handlers })` (required by type when the
manifest declares ref Procedures) and run `tsc --noEmit`. A handler receives `{ caller, db, store }`
bound to the same caller and transaction; the exported `procedures` map holds SQL Procedures only.

## Workers build

In a workspace consumer with the experimental package linked, run generation once:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts
pnpm exec wrangler deploy
# or: pnpm exec wrangler dev --local
```

For `cloudflare-d1` and `cloudflare-postgres`, generation configures Wrangler to run
`mantle bundle <entry> <outdir>` automatically. Node 22 suffices. Run from the project root;
regenerate after manifest or auth option changes.

`--entry` defaults to `src/worker.ts`, `--outdir` to `dist`. `--wrangler` defaults to the
existing `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`, otherwise `wrangler.jsonc`.
JSONC edits preserve comments and unrelated settings and are idempotent. A new config
needs its `name`, `compatibility_date` and bindings filled in. TOML only prints instructions.

esbuild emits minified split ESM; Wrangler uploads it with `no_bundle`,
`find_additional_modules`, `base_dir` and an ESModule rule. `nodejs_compat` is ensured.
The metafile guard rejects `better-auth` / `@better-auth/*` in the static startup graph:
use `authLoader(() => import(...))` ([Auth](../../docs/next/auth.md#worker-entry)).
The output directory is cleaned first; keep source and generated code elsewhere.

## Admin

Mount the generated `admin({ db: env => env.DB, caller, assets, ... })` in the
app's Fetch entry. `/admin/api` accepts cookie-session users with OSS role
`staff`; the shell assets remain app-owned. It includes bootstrap metadata,
site reads, staff View paging/search/filter/CSV and staff Procedure execution.
See [the Admin contract](../../docs/next/surfaces.md#mounting-admin) for display
identity, native wire adapters and selected follow-up modules. Importing another
generated entry excludes Admin from that bundle.

## D1 Sessions

D1's session handle already satisfies generated Views/Procedures and the Store's structural `db` type:

```ts
const bookmark = request.headers.get("x-d1-bookmark");
const session = env.DB.withSession(bookmark ?? "first-unconstrained");
const rows = await views.catalog(session, caller, {});
const data = store(session, caller); // use the same handle for Store operations
return Response.json(rows, { headers: { "x-d1-bookmark": session.getBookmark() ?? "" } });
```

Return `session.getBookmark()` in a header or cookie and have the client pass it back on the next request.
Keep `resolveCaller` and Better Auth on `env.DB`: revocation and roles must read the primary.
Enable [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
on the database (dashboard or REST); writes always go to the primary.

## Store transactions

Writes are lazy thenables: await `collection.insert/update/delete(...)` to execute once,
or pass unused Writes from the same Store to `store.batch([...])` for atomic results in input order;
a stale lock, excluded row or unique clash rolls back the whole batch with `CONFLICT`.
A batch step cannot use a previous step's result. D1 supports only batch.
On bun:sqlite and PostgreSQL, `store.transaction(async tx => { ... })` binds `collection`, `views`
and `procedures` to one transaction: resolve commits, throw rolls back; nested transactions and `tx.batch` are refused.
PostgreSQL defaults to serializable; `{ isolation: "read committed" }` selects another level. There is no automatic retry.
SQLite uses BEGIN IMMEDIATE and queues all Store/generated driver calls on the same Database until COMMIT/ROLLBACK;
Inside a transaction callback the outer Store or handle passed to a Mantle driver throws `INPUT_VALIDATION_FAILED`; use `tx`.

Views return full SQL results; Procedures return `{ results }`. Their atomicity and
uncertain-write outcomes follow the [query contract](../../docs/next/contract.md#revised-query-responsibility-decision-2026-10-11).

PostgreSQL handles (Bun.SQL, postgres.js) satisfy the two-method `Postgres` shape as they are; see the [contract](../../docs/next/contract.md).
Procedures return native results directly. Unsupported declarations fail generation with actionable diagnostics;
see the [supported/refused list](../../docs/next/compatibility.md) for current scope and planned features.

Checks:

```sh
pnpm --dir packages/mantle-next run typecheck
pnpm --dir packages/mantle-next run test
# Set MANTLE_NEXT_BUN_PG_URL and MANTLE_NEXT_WORKER_PG_URL to disposable local DBs.
pnpm --dir packages/mantle-next run test:native
```

The native runner executes all four real engines/hosts locally, with independent
procurement fixtures and native SQL oracles. It creates fresh PostgreSQL schemas;
SQL/time/driver behavior is compared per engine, not normalized across engines.
Cloudflare tests create no cloud resources. Formal benchmark runs need a quiet
machine and a fresh private output directory; raw samples must accompany claims.
The [size and startup gates](../../docs/next/size-and-startup.md) cover the
bundle and package budgets. The packed generator still needs its workspace compiler
dependency made standalone before publication.
This package is not a released replacement for Mantle 0.2.
