# Native execution and hook migration

The cleanup in [ADR-0041](../../adr/0041-native-driver-and-application-hook-ownership.md)
removes database coordination and before-hook policing. Existing generated
source is application-owned and is never silently rewritten. Generate a
scratch service for the same host/dialect/selection and review the differences
before updating your service. No new manifest key is required.

## PostgreSQL

Remove `requestScoped`, `PgSession`, `session.run`, generated listener registries
and `pipeline: true`. On Bun keep one official `pg.Pool` for the application
lifetime, pass it directly to Better Auth, and use `pool.connect()` at the
Store/auth SQL acquisition seam. On Workers use the official `pg.Client` and
its platform-supported lifetime; Hyperdrive owns pooling. The required Kysely
Client-to-pool shape on Workers owns no pool or request session.

The driver returns a native PoolClient with `release`, or closes a standalone
Client with `end`. Do not adapt `pool.query` into an atomic batch: BEGIN,
statements and COMMIT must use the same acquired client. Close the application
Pool after the server and retained work have finished.

Write batches retain native PostgreSQL SERIALIZABLE and execute sequentially.
There is no Mantle pipeline or automatic serialization/deadlock retry/backoff.
Handle native failures in application logic; never blindly retry an unknown
commit. Failed rollback or unusable sockets discard the client. A lost COMMIT
answer is OUTCOME_UNKNOWN even if cleanup later succeeds. Reads remain native
single statements without a Mantle write transaction.

Database role settings and schema-convergence advisory locking retain their
existing contracts. This cleanup does not remove migration safety or add a
replacement resource manager. Local Wrangler PG does not validate cloud
Hyperdrive caching, pooling or network latency.

## Bun SQLite

Better Auth's [official PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)
accepts the native Pool, and its [Bun SQLite adapter](https://better-auth.com/docs/adapters/sqlite)
accepts a native Database. Sharing a Pool means sharing acquisition capacity;
it does not merge Auth and Store transactions. [node-postgres transactions](https://node-postgres.com/features/transactions)
use one acquired client throughout. PostgreSQL's default Read Committed already
prevents dirty reads; Mantle's stronger write-batch isolation is a separate,
explicit contract. [SQLite isolation](https://www.sqlite.org/isolation.html)
applies between connections; operations on the same connection can see its
uncommitted writes. The two-handle composition below follows SQLite's native
isolation, rather than a Better Auth requirement or an SDK scheduler.

The authenticated preset opens two official bun:sqlite handles to the same
file: `DB` for Store and ancillary auth SQL, `AUTH_DB` exclusively for Better Auth.
Fresh-role and bootstrap SQL must not bypass Better Auth's mutex by using its
async transaction handle; they read committed data on `DB`.
Use WAL mode and close both handles after shutdown. Initialize `AUTH_DB`
with `authDb.exec("PRAGMA foreign_keys = ON")` before handing it to Better Auth;
its native Bun adapter does not enable SQLite foreign keys automatically. The authenticated
two-handle preset rejects `:memory:`; two independent memory handles do not
share a database. A storage-only in-memory database remains supported.

Do not share a handle across an asynchronous transaction. A same-handle
Store/driver call during such a transaction fails promptly, rather than
reading uncommitted rows or acknowledging a nested savepoint that a later
rollback can erase. Better Auth owns its own transaction behavior; its pinned
queued after-transaction bootstrap hook runs after commit.

Views use native cached reads without BEGIN IMMEDIATE or Mantle polling.
With a different native handle holding a WAL write transaction, readers see
the committed snapshot. Native busy timeout, journal mode, schema locks and
application-selected settings remain SQLite behavior, not a guarantee that
any arbitrary SQLite query can never block. D1 uses its own native bindings.

## Before hooks and guards

Before hooks retain their declared event snapshots and execution order. They
can write through the normal caller-bound Store and invoke another Procedure;
the invoked operation still enforces authorization, scope and the existing
invocation depth limit. Hooks receive no write sandbox and no implicit OCC
solely because they are hooks.

A thrown hook error prevents the outer mutation. A hook's independently
committed writes and external side effects remain; they are not part of the
outer transaction. Authors own these effects and races. Use native database
constraints/authored SQL for atomic business conditions, or provide explicit
caller OCC. Publishing retains its own state/full-entry checks and version
protection. Authorization guards still cannot write or invoke.

Validation checks references and declared shapes during authoring, and checks
incoming plans/inputs at trust boundaries. It cannot prove arbitrary
JavaScript is pure, correct or race-free. There is no handler analyzer or new
runtime enforcement layer for application business rules.

## Database targets and performance

SQLite and PostgreSQL retain their native syntax, NULL ordering, collation,
indexes, planner and transaction behavior. Choose a target and author its SQL;
switching databases is an explicit migration. Mantle does not promise
cross-database result or performance equality.

Per-operation Workers connections and sequential PostgreSQL writes may cost
more than the removed wrappers. Measure SQL messages, commands, bindings,
transactions, checkouts and physical connections separately. Do not add a
second pool, retry scheduler, stream-scope manager or parity shim to hide that
tradeoff.

Product site/media reads also use native read ports. Warm SQLite preparation
avoids no-op DDL when system objects and the existing fingerprint are ready;
this does not add detection of arbitrary external table/index drift. Media
ordering receives a Core-owned index without changing its numeric cursor.
Custom structural R2 bindings must implement the official native
`delete(string | string[])` shape. See [ADR-0042](../../adr/0042-native-query-work-cleanup.md).
