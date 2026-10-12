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

Every Schema is also a typed **Store** collection, in the shape of a document-database driver:
`store(db, caller).collection("purchase_requests")` with `findById`, `find` (AND-only `where`, keyset `cursor`), `first`,
`count`, `insert(values)`, OCC `update(id, set, { lock })` and `delete(id, { lock })`. Rows, `where`, `set` and `orderBy` use the
table's storage column names, lower-case (`requestnumber`, `created_at`), the keys a generated View returns; the generated types
state column names, value types and the writable columns, and the Store enforces the Schema's row rules (scope, TTL, version) but
**not** a View's or Procedure's `requires`: authorize before calling it. Design, limits and what the runtime still refuses are in
[ADR-0045](../../docs/adr/0045-next-runtime-core.md).

A Store-only purchase Worker retains 1,450 gzip bytes of generated operations (Bun 1.3.14, minified); the existing bound operation API stays intact.

## Workers build

In a workspace consumer with the experimental package linked, run generation once:

```sh
pnpm exec mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts
pnpm exec wrangler deploy
# or: pnpm exec wrangler dev --local
```

For `cloudflare-d1` and `cloudflare-postgres`, generation writes Wrangler's custom split ESM build,
so plain `wrangler deploy` / `wrangler dev` run it automatically. Node 22 suffices; Bun is not required.
`--wrangler` defaults to `wrangler.jsonc`, `--entry` to `src/worker.ts`, and `--outdir` to `dist`.
JSONC edits preserve comments and unrelated settings, and rerunning generation leaves the same config.
A missing config gets placeholders for `name` and `compatibility_date`; fill those and your bindings.
TOML is left untouched with the exact keys to add printed to the terminal.
Run generation and Wrangler from the project root. Regenerate after changing manifests or auth options.

The custom command is `mantle bundle <entry> <outdir>`: esbuild 0.28.1 creates minified ESM
with chunks under `chunks/`, cleaning the output directory first. Wrangler uploads these modules with
`no_bundle`, `find_additional_modules`, `base_dir` and an ESModule rule; `nodejs_compat` is ensured
for AsyncLocalStorage and postgres.js. The build rejects Better Auth in the entry's static import graph
using esbuild's input/output metafile, independent of bundle size. Load auth with
`authLoader(() => import(...))`; see [Auth](../../docs/next/auth.md#worker-entry).
Do not put source or generated code in the bundle output directory.

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
Maintainer-reported measurements for [#1465](https://github.com/aotter/mantle/issues/1465):
a Worker at SJC reading an APAC primary took ~120 ms/read; with replication and a session, a WNAM
replica served reads in ~40 ms. `session.batch` reads also used the replica. These are deployment-specific observations.

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
Procedures return native results directly. Before/after hooks, guarded/ref handlers and Triggers are not implemented;
declarations requiring them fail generation. See the complete
[compatibility ledger](../../docs/next/compatibility.md).

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
