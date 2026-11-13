---
description: Native execution, database handles, two SQL dialects and application-owned migrations.
---
# Runtime and databases

`mantle generate` compiles manifest SQL and row policy into ordinary TypeScript and SQL. Generated Views and Procedures call the target's native driver. The app owns routing, authentication, handles, connection lifetime and deployment. Import only the operations and surfaces you use.

## Schema installation and migrations

The runtime never creates, alters or checks tables. Boot and requests run no DDL, introspection or schema checks.

For the first install, apply generated `schema.sql`, including selected auth/site DDL, to an empty database. Apply selected seed SQL explicitly.

For every later schema change, the application's coding agent diffs the regenerated `schema.sql`, writes a migration with the host's native tool (`wrangler d1 migrations` or the app's PostgreSQL migration tool), rehearses it on a copy, and applies it before deploying the new code.

Destructive changes and type changes need explicit data migration. Mantle drops nothing. Initial `schema.sql` is not an upgrade script.

## Drivers and dialects

The driver layer is open: handles are structural contracts, not a registration API. PostgreSQL needs `unsafe(text, values)` and `begin(options, fn)` from `@aotter/mantle/contracts`; SQLite uses D1's prepare/bind/all/batch shape or bun:sqlite's query/transaction shape. Bun.SQL and postgres.js fit directly. See [adapting a driver](../guides/postgres-adapters.md).

Users may supply anything that executes the emitted SQL, including WASM SQLite persisted to IndexedDB, at their own risk. Mantle promises behavior only on supported drivers: bun:sqlite, D1, Bun.SQL and postgres.js. A structural match alone does not prove transaction, result or error semantics.

The dialect layer is closed in 0.2: exactly `postgres` and `sqlite`, selected by the generation target. SQL is rendered at generation time. A third engine requires forking the compiler and Store runtime; it is not a dialect plugin.

## Store and queries

Use the [Store for writes and simple lookups, internal Views for richer reads](../guides/typed-queries.md). Store metadata initializes once on first `store()` use without SQL. Each call binds a fresh handle, verified Caller and handlers; never reuse a caller-bound Store across requests.

[Native execution](../guides/native-execution.md) defines input ownership, native result values, atomicity and uncertain write outcomes.

## Your own SQL in a Store transaction

On PostgreSQL and bun:sqlite, `store(db, caller).transaction(fn, options)` calls `fn(tx, db)`: `tx` is the Store bound to
the transaction and the second argument is the transaction's own native handle, typed as the handle you passed in
(`Postgres` from `@aotter/mantle/contracts` on PostgreSQL). Use it for SQL the manifest does not declare (an advisory
lock, a write to a table the application owns) in the same transaction as generated Procedures:

```ts
import type { Caller, Postgres } from "@aotter/mantle/contracts";
import { procedures, store } from "../generated/generated.js";

export function placeOrder(db: Postgres, caller: Caller, key: number, input: { item: string }) {
  return store(db, caller).transaction(
    async (tx, sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
      await sql.unsafe("INSERT INTO order_audit (key, item) VALUES ($1, $2)", [key, input.item]);
      await procedures["reserve-stock"](sql, caller, input); // a generated function given `sql` joins too
      return tx.procedures["place-order"](input);
    },
    { isolation: "read committed" },
  );
}
```

What Mantle promises on PostgreSQL (Bun.SQL and postgres.js, so both `bun-postgres` and `cloudflare-postgres`):

- **One transaction.** Everything run on `sql` or `tx`, and every generated View or Procedure given `sql`, runs inside
  it: no second BEGIN, and their rows are visible to later statements on `sql` and invisible elsewhere until COMMIT.
  COMMIT runs once, after `fn` resolves. A throw from `fn` rolls everything back, including transaction-level advisory
  locks. `sql` stops working when `fn` settles ("Transaction has ended").
- **Isolation.** `serializable` by default; `isolation` takes `"serializable"`, `"repeatable read"`, `"read committed"`
  or `"read uncommitted"`, and anything else is `INPUT_VALIDATION_FAILED` before any SQL. There is no read-only option.
- **Failures you catch still roll back.** A failed multi-statement Procedure or `tx.batch` makes the transaction
  rollback-only even if `fn` catches it: the transaction rejects with that error and nothing commits. On PostgreSQL any
  failed statement, yours or generated, aborts the transaction the same way; the rejection is the known rollback
  (postgres.js rethrows the statement's error, Bun.SQL reports `ERR_POSTGRES_COMMIT_ROLLED_BACK`), never
  `OUTCOME_UNKNOWN`. A single-statement Store write or Procedure that fails its row check (`CONFLICT` with no SQL error)
  changed nothing, and catching it leaves the transaction usable. Prefer letting errors propagate.
- **No nesting.** Opening a transaction inside one, on `sql` or on a Store built from it, is refused; there are no
  savepoints. Using the outer `db` or its Store inside is `INPUT_VALIDATION_FAILED`.
- **No retry.** A serialization failure or deadlock (`40001`, `40P01`) is `CONFLICT` with `kind: "serialization"`; the
  transaction rolled back and is not retried. A COMMIT whose answer is lost (a dropped connection) is
  `OUTCOME_UNKNOWN`: reconcile before acting on it again.
- **Authorization.** SQL you run on `sql` has the database role's rights: no Caller, scope, TTL, publishing or
  system-column rule and no `authorize` applies to it. Generated Views, Procedures and `tx` inside the same transaction
  still apply their Caller's `requires`, scope and row rules. A raw handle is a way around row rules: keep this code in
  trusted server code, never build SQL text from request input (bind values), and run your own authorization first.

On bun:sqlite the handle is the `Database` (`Handle` from `@aotter/mantle/driver/bun-sqlite`), the transaction is
`BEGIN IMMEDIATE` and ignores `isolation`, and a failed SQLite statement does not abort the transaction by itself. D1
has no interactive transaction; use a batch or a multi-statement Procedure.

**On Workers through Hyperdrive.** The driver contract runs every statement of `begin` on one connection, and Hyperdrive
pools by transaction: it keeps one database connection for a transaction until it ends (Cloudflare's documented
behaviour; Mantle's own tests run in workerd against Wrangler's local Hyperdrive binding, which connects directly).
Session state does not survive between transactions there, so use
transaction-scoped forms: `pg_advisory_xact_lock` rather than `pg_advisory_lock`, `SET LOCAL` rather than `SET`; both end
with the transaction. Keep the callback short and make no external calls inside it: the open transaction holds its
connection and locks for as long as the Worker request awaits. Mantle sets no timeout; the Worker's limits and the role's
`statement_timeout` and `idle_in_transaction_session_timeout` apply. Statement preparation is the postgres.js client's
option, unchanged by Mantle. Disable Hyperdrive query caching as for every Mantle database
([deploy and operate](../cloudflare/deploy-and-operate.md)).
