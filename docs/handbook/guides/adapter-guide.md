# Another host or database handle

Mantle has an open driver boundary and exactly two closed dialects in 0.2, postgres and sqlite. Choose the generation target whose emitted SQL and handle calls match your host. The app owns its router, resources, lifetime and scheduler.

PostgreSQL's `Postgres` in `kernel/contracts.ts` needs `unsafe(text, values)` and `begin(options, fn)`. Bun.SQL and postgres.js fit without wrappers. [The node-postgres example](postgres-adapters.md) shows the transaction and result-count contract. SQLite handle contracts are exported by `@aotter/mantle/driver/d1` and `/driver/bun-sqlite`: D1 prepare/bind/all/batch, or SQLite query/exec/transaction. Reads may need only the narrower reader shape.

A third-party driver must preserve result, binding, atomicity and uncertain-outcome semantics. A handle that cannot transact must reject before invoking the callback. Never emulate an atomic Procedure with unrelated autocommit HTTP calls.

Users may choose another SQL executor, including WASM SQLite persisted to IndexedDB, at their own risk. Mantle supports bun:sqlite, D1, Bun.SQL and postgres.js; there is no bundled Durable Object adapter. The app owns any custom adapter and its tests. A third SQL engine requires forking the compiler and Store runtime, not installing a dialect plugin.

No runtime performs DDL, introspection or schema checks. Install initial SQL and rehearse migrations explicitly; see [database ownership](../concepts/runtime-and-adapters.md).
