# Mantle

Generate native SQL for Bun SQLite/PostgreSQL and Cloudflare D1/PostgreSQL.
The build-time compiler uses the closed v2 grammar and canonical SQL policy.
Applications import contract primitives and official drivers.

Three packages: `@aotter/mantle` is the SDK with bin `mantle`; `@aotter/mantle-ui` is pure UI without an SDK dependency; `@aotter/mantle-admin` is the optional product with the SDK as a peer. Use matching installed versions and their own docs.

Select `--admin` / `admin: true` for [Native Admin](./docs/handbook/guides/native-admin.md).
Its generated adapter mounts with `entries(bindings.schemas, bindings.adapter)`;
shared read templates and generated Procedure fragments preserve the native
row policy and checks without importing generic Store into initial Admin reads.

Build and contributor checks: [CONTRIBUTING](https://github.com/aotter/mantle/blob/develop/CONTRIBUTING.md).

Outputs include `generated.ts`, `schema.sql` and direct operation entries.
Commit generated output and Wrangler edits; keep `dist/` untracked. Run the same
generate command with `--check` in CI. Never hand-edit generated files; merge
manifest/options changes and regenerate. See [service composition](./docs/handbook/cloudflare/service-entry.md)
for app-owned routing, assets, scheduling, Bun and the generated-output workflow.
Import `views/<encoded-name>.ts` or `procedures/<encoded-name>.ts` (default export
and types) to exclude other operations. Apply initial DDL to an empty development
database; it is not a production migration. Generation performs no database I/O.
Call `views[name](db, caller, input)` or `procedures[name](db, caller, input)` with
driver-ready inputs, a native handle (Bun.SQL, bun:sqlite Database or D1 binding)
and a verified Caller.

Validate untrusted input before calling queries and redact native errors at application
transports. The [query contract](./docs/handbook/guides/native-execution.md#query-inputs-values-and-outcomes)
defines driver-ready inputs, native results, date-time/date wire forms and failure handling.

For transports, `paged/views/<name>.ts` returns `{ rows, nextCursor? }` with keyset paging and
`validation/<kind>/<name>.ts` checks input against the declared JSON Schema subset; the
[surface deltas](./docs/handbook/reference/surface.md) define the REST/MCP wire contract.
Proved internal Views also get paging without a public route/tool: one SELECT
per page, validated scalar cursor keys and hidden-key removal. Schema tuples
need indexed order after fixed equality prefixes ([index prefixes](./docs/handbook/reference/schema.md#index-prefixes-for-paged-views)); complete groups and singleton
joins are supported. Grouping still scans/aggregates its source: inspect EXPLAIN.
Unsupported internal SQL retains its bare module.

Every Schema is a typed **Store** collection:
`store(db, caller).collection("purchase_requests")` with `findById`, `find` (AND-only `where`, `{ rows, cursor }` keyset pages), `first`,
`count`, `insert(values)`, OCC `update(id, set, { lock })` and `delete(id, { lock })`. Rows, `where`, `set` and `orderBy` use the
table's storage column names, lower-case (`requestnumber`, `created_at`), the keys a generated View returns; the generated types
state column names, value types and the writable columns, and the Store enforces the Schema's row rules (scope, TTL, version) but
**not** a View's or Procedure's `requires`: authorize before calling it. Design, limits and what the runtime still refuses are in
[Store guide](./docs/handbook/guides/typed-queries.md).

Importing generated modules does not initialize the Store. The first `store()`
call prepares its metadata factory once; every call binds its own database,
Caller and handlers. Unused Stores still tree-shake out of direct operations.

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

## Design MCP services around the user's goal

For a new service, run the version-matched [MCP design audit and business
acceptance flow](./docs/handbook/guides/agent-workflow-acceptance.md) before
implementing tools. Map the goal to bounded discovery, complete detail/relation
readback, committed write results, version/state rules and recovery under the
intended caller. After implementation, use the same guide's fresh end-user
agent → repair → independent retest loop. Static design review, scripted checks
and real host/UI acceptance are separate evidence.

## Publishing

Schemas default to `lifecycle: operational`. Opt-in `lifecycle: publishing` adds status
(`draft` default, `published`, `archived`), nullable `published_at` and a scope-aware
`(published_at, id)` index; `published_at` is selectable in Views and orders Store `find`
(`NULLS LAST`). Generated `<table>.publish`, `.unpublish` and `.archive` Procedures take
`{ id, expectedVersion }`, gate admin/system callers and run one atomic UPDATE; a failed guard is
`CONFLICT`. Store writes cannot set status or `published_at`. Public Views see published rows only;
other reads expose drafts only to admin or system callers.

## Ref Procedures

A Procedure with a `ref` handler generates a typed `Handlers` interface. `mantle generate` lists the
handlers to implement; pass them at `store(db, caller, { handlers })` (required by type when the
manifest declares ref Procedures) and run `tsc --noEmit`. A handler receives `{ caller, db, store }`
bound to the same caller and transaction; the exported `procedures` map holds SQL Procedures only.

## Workers build

In an application, run generation:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts
pnpm exec wrangler deploy
# or: pnpm exec wrangler dev --local
```

For `cloudflare-d1` and `cloudflare-postgres`, generation configures Wrangler to run
`mantle bundle <entry> <outdir>` automatically. Node 22.22 or newer is required. Run from the project root;
regenerate after manifest or auth option changes.

`--entry` defaults to `src/worker.ts`, `--outdir` to `dist`; with `--admin`, `--assets` (Wrangler's `assets.directory`) defaults to `<outdir>/client`. `--wrangler` defaults to the
existing `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`, otherwise `wrangler.jsonc`.
JSONC edits preserve comments and unrelated settings and are idempotent. A new config
needs its `name`, `compatibility_date` and bindings filled in. TOML only prints instructions.

esbuild emits minified split ESM into `<outdir>/worker`; Wrangler uploads it with `no_bundle`,
`find_additional_modules`, `base_dir` and an ESModule rule. Generation ensures
`nodejs_compat` and defaults to `global_fetch_strictly_public`, including explicit
environment flag overrides; see [Workers deployment](./docs/handbook/cloudflare/deploy-and-operate.md).
The metafile guard rejects `better-auth` / `@better-auth/*` in the static startup graph:
use `authLoader(() => import(...))` ([Auth](./docs/handbook/cloudflare/authentication.md#worker-entry)).
The Worker directory is cleaned first; keep source and generated code elsewhere. A Worker that imports
`@aotter/mantle-admin/server` also gets Admin, built with Vite into `<assets>/admin` (default `<outdir>/client/admin`)
from `admin.tsx` beside the entry or the built-in entry. The built-in entry is skipped while the installed
Admin and its direct dependencies are unchanged; an `admin.tsx` entry builds every time.

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

Views return rows; Procedures return `{ results }`. See the [query contract](./docs/handbook/guides/native-execution.md#query-inputs-values-and-outcomes)
for atomicity and uncertain writes.

PostgreSQL handles (Bun.SQL, postgres.js) satisfy the two-method `Postgres` shape as they are; see the [contract](./docs/handbook/guides/native-execution.md).
Unsupported declarations fail generation with diagnostics;
see the [supported/refused list](./docs/handbook/reference/features.md) for current scope and planned features.

Native contributor checks run all four hosts with independent SQL oracles and
fresh PostgreSQL schemas; behavior follows each engine. Local Cloudflare checks
create no cloud resources. Performance claims need a quiet machine and raw samples.
The [size and startup gates](./docs/handbook/guides/size-and-startup.md) cover the
bundle and package budgets. The private compiler ships in this SDK and stays outside request imports.

## Data paths and migrations

Writes use Store or declared Procedures, never raw SQL writes that bypass scope, TTL, publishing and system columns. Internal Views are for joins, aggregates, OR and reusable reads. Store findById/find/first remain useful for simple handler lookups and partial adoption in existing TypeScript/Node apps using their own native handle and verified Caller.

The runtime never creates, alters or checks tables; boot and requests run no DDL. Apply initial schema.sql plus selected auth/site DDL to an empty database. For each later change, the app's agent diffs regenerated SQL, writes a native migration, rehearses it on a copy and applies it before deploying code. Destructive/type changes need explicit data migration; Mantle drops nothing.

[Drivers are open structural handles; dialects are exactly postgres and sqlite](./docs/handbook/concepts/runtime-and-adapters.md#drivers-and-dialects).
