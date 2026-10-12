# Mantle (experimental)

Compile closed v2 manifests into typed native SQL for Bun SQLite, Bun PostgreSQL,
Cloudflare D1 and Cloudflare PostgreSQL. Generated code uses the selected native
driver and shared kernel; it imports no compiler or execution plan. No runtime
DDL, schema checks, connection ownership or automatic migration.

Build Core and this package before generation:

```sh
pnpm --dir packages/mantle run build
pnpm --dir packages/mantle-next run build
```

`mantle generate <target> <directory> manifests/*.yaml` emits `schema.sql`,
`generated.ts` and direct operation entries. Apply DDL explicitly to an empty
database; production migrations belong to the application. Import a selected
`views/<encoded-name>.ts` or `procedures/<encoded-name>.ts` default export to
exclude unused operations from bundles. Functions take `(db, caller, input)`;
Views return rows and Procedures return `{ results }`. Pass verified Callers and
application-validated inputs. Native errors require boundary redaction. See the
[query contract](../../docs/next/contract.md) for scalar wire forms, OCC,
authorization, atomicity and uncertain-commit outcomes.

Store collections use storage column names:
`store(db, caller).collection(name)` exposes `findById`, `find`, `first`, `count`,
`insert`, OCC `update(id, set, { lock })` and `delete(id, { lock })`. Typed AND-only
filters and indexed keyset ordering apply scope/TTL/visibility; Store does not
check a Procedure's `requires`. `find` returns `{ rows, cursor }`; filters and
ordering must stay fixed across pages. Indexed ordering requires NOT NULL except
publishing's nullable `published_at`, which uses `NULLS LAST` in both directions.

For transports, `paged/views/<name>.ts` returns `{ rows, nextCursor? }` with keyset paging and
`validation/<kind>/<name>.ts` checks input against the declared JSON Schema subset; the
[surface deltas](../../docs/next/surfaces.md) define the REST/MCP wire contract.

Every Schema is also a typed **Store** collection, in the shape of a document-database driver:
`store(db, caller).collection("purchase_requests")` with `findById`, `find` (AND-only `where`, keyset `cursor`), `first`,
`count`, `insert(values)`, OCC `update(id, set, { lock })` and `delete(id, { lock })`. Rows, `where`, `set` and `orderBy` use the
table's storage column names, lower-case (`requestnumber`, `created_at`), the keys a generated View returns; the generated types
state column names, value types and the writable columns, and the Store enforces the Schema's row rules (scope, TTL, version) but
**not** a View's or Procedure's `requires`: authorize before calling it. Design, limits and what the runtime still refuses are in
[ADR-0045](../../docs/adr/0045-next-runtime-core.md).

Schemas default to `lifecycle: operational`. Opt-in `publishing` adds status
(default `draft`), nullable `published_at` and its scope-aware index. Generated
`<table>.publish`, `.unpublish` and `.archive` Procedures take
`{ id, expectedVersion }`, gate staff/system callers, and atomically check scope,
TTL, version and source state. Publish requires the required fields. Store writes
cannot set status or published_at; staff can edit published entries. Public Views
always see published rows; other Views and Store expose drafts only to staff or
system callers. Translations and lifecycle hooks are unsupported.

For Workers, generation configures Wrangler's native split build:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts
pnpm exec wrangler dev --local
pnpm exec wrangler deploy
```

`--entry` defaults to `src/worker.ts`, `--outdir` to `dist`; JSONC edits preserve
comments and unrelated configuration. Fill in Worker name/date/bindings. TOML
prints instructions. `mantle bundle` emits split ESM and refuses Better Auth in
the static startup graph: load application auth through `import()`.

D1 session handles satisfy the generated database type. Use one session for
queries/Store and return `session.getBookmark()` for subsequent requests; keep
auth on the primary binding. Bun.SQL and postgres.js both satisfy the PostgreSQL
`unsafe`/`begin` shape without adapters. Connection/pool lifetime is application-owned.

esbuild emits minified split ESM; Wrangler uploads it with `no_bundle`,
`find_additional_modules`, `base_dir` and an ESModule rule. `nodejs_compat` is ensured.
The metafile guard rejects `better-auth` / `@better-auth/*` in the static startup graph:
use `authLoader(() => import(...))` ([Auth](../../docs/next/auth.md#worker-entry)).
The output directory is cleaned first; keep source and generated code elsewhere.

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
