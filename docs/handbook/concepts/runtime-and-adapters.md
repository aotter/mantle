---
description: Native execution, database handles, two SQL dialects and application-owned migrations.
---
# Runtime and databases

`mantle generate` compiles manifest SQL and row policy into ordinary TypeScript and SQL. Generated Views and Procedures call the target's native driver. The app owns routing, authentication, handles, connection lifetime and deployment. Import only the operations and surfaces you use.

## Schema installation and migrations

The runtime never creates, alters or checks tables. Boot and requests run no DDL, introspection or schema checks.

For the first install, apply generated `schema.sql`, including selected auth/site DDL, to an empty database. Apply selected seed SQL explicitly.

For every later schema change, the application's coding agent diffs the regenerated `schema.sql`, writes a migration with the host's native tool (`wrangler d1 migrations` or the app's PostgreSQL migration tool), rehearses it on a copy, and applies it before deploying the new code. Cloud executes migrations at deploy time.

Destructive changes and type changes need explicit data migration. Mantle drops nothing. Initial `schema.sql` is not an upgrade script.

## Drivers and dialects

The driver layer is open: handles are structural contracts, not a registration API. PostgreSQL needs `unsafe(text, values)` and `begin(options, fn)` from `@aotter/mantle/contracts`; SQLite uses D1's prepare/bind/all/batch shape or bun:sqlite's query/transaction shape. Bun.SQL and postgres.js fit directly. See [adapting a driver](../guides/postgres-adapters.md).

Users may supply anything that executes the emitted SQL, including WASM SQLite persisted to IndexedDB, at their own risk. Mantle promises behavior only on supported drivers: bun:sqlite, D1, Bun.SQL and postgres.js. A structural match alone does not prove transaction, result or error semantics.

The dialect layer is closed in 0.2.0: exactly `postgres` and `sqlite`, selected by the generation target. SQL is rendered at generation time. A third engine requires forking the compiler and Store runtime; it is not a dialect plugin.

## Store and queries

Use the [Store for writes and simple lookups, internal Views for richer reads](../guides/typed-queries.md). Store metadata initializes once on first `store()` use without SQL. Each call binds a fresh handle, verified Caller and handlers; never reuse a caller-bound Store across requests.

[Native execution](../guides/native-execution.md) defines input ownership, native result values, atomicity and uncertain write outcomes.
