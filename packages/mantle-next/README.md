# Mantle Next (unpublished experiment)

Generate typed, concrete SQL functions for Bun SQLite, Bun PostgreSQL,
Cloudflare D1 and Cloudflare PostgreSQL. The compiler uses 0.2's closed v2
manifest grammar and canonical SQL policy/printers at build time. The generated
application imports portable contract primitives and official drivers only.

```sh
pnpm --filter @aotter/mantle build
pnpm --filter @aotter/mantle-next build
pnpm --filter @aotter/mantle-next generate cloudflare-d1 /tmp/purchase-generated tests/apps/purchase.yaml
```

Outputs include `generated.ts`, `schema.sql` and direct operation entries.
Import a selected function from `views/<encoded-name>.ts`,
`procedures/<encoded-name>.ts` or `stores/<schema>.ts` (default export, with its
types) to exclude other operations from the request bundle. Apply initial DDL explicitly to an
empty development database; this artifact is not a destructive migration or a
production convergence tool. Generation does no database I/O. Application code
passes driver-ready parameters, a database handle (Bun.SQL `SQL` for PostgreSQL, `bun:sqlite`
Database, D1 binding) and a verified
Caller to `views[name](db, caller, input)` or
`procedures[name](db, caller, input)`.

Default queries contain no validator, scalar decoder, row projection or generic
database-error wrapper. Validate untrusted input before calling them; redact
native errors at application transports (they are rethrown as they are). JSON binds are JSON text; SQLite bool
and fixed numeric binds use native storage values. Bound fields are explicit (null for absence). Rows use SQL names and official
driver representations (PG int8 strings, SQLite 0/1 booleans), except declared
date-time and date columns: the SQL returns them (Views and `RETURNING`) as ISO
strings in UTC with six fractional digits and `YYYY-MM-DD` on every target, and
inputs bound to them take the same ISO text (a valid `Date` also works for date-time); an offset-less
timestamp or a nonexistent day is refused with `SQL_TYPE` before the write.

Every Schema also gets a typed **Store** (`stores[schema](db, caller)`: `findById`, `find` with AND-only
`where` and keyset `cursor`, `first`, `count`, OCC `update(id, set, { lock })`). Its policy is Core's own
lowering of `SELECT r.* FROM <schema> r` and of one `UPDATE`; it only appends `WHERE`, `ORDER BY`, `LIMIT`.
`orderBy` takes `id` and indexed columns. See the [contract](../../docs/next/contract.md).

The first slice provides **full-result SQL functions**, not the old paginated
View API. SQL Procedures return their existing `{ results }` shape and retain
row expectations inside native atomic transactions. A single-statement Procedure
is one atomic statement and runs without BEGIN/COMMIT (one PG round trip); a
multi-statement Procedure uses SERIALIZABLE on PG through `begin()`, with no
automatic retries. Never assume a lost commit answer means rollback after
OUTCOME_UNKNOWN; reconcile first.

Bun.SQL (pass its pooled `SQL` to multi-statement Procedures: they `begin` themselves) and postgres.js (`postgres(env.HYPERDRIVE.connectionString)` on Workers) satisfy the two-method
`Postgres` shape from `@aotter/mantle-next/contracts` as they are; there is no adapter. Procedures return native results directly. Before/after hooks, guarded/ref handlers and Triggers are not implemented;
declarations requiring them fail generation. See the complete
[compatibility ledger](../../docs/next/compatibility.md).

There is no old-runtime fallback, request-time plan verification, dynamic query
compiler, custom pool, lock polling or hook sandbox. Boundary validation belongs to the
application. Output names are emitted into the SQL; binds are Core's recipes, evaluated by
the shared `kernel/binds`. Computed PG values need per-query wire metadata for a known native type.

PostgreSQL session settings (DateStyle ISO/YMD, IntervalStyle postgres, TimeZone UTC,
standard_conforming_strings on, extra_float_digits 1, a positive statement_timeout) are
deployment configuration on the ROLE or DATABASE; Hyperdrive does not keep client SETs.
Generated functions neither set nor verify them. See the [contract](../../docs/next/contract.md).

Checks:

```sh
pnpm --filter @aotter/mantle-next typecheck
pnpm --filter @aotter/mantle-next test
# Set MANTLE_NEXT_BUN_PG_URL and MANTLE_NEXT_WORKER_PG_URL to disposable local DBs.
pnpm --filter @aotter/mantle-next test:native
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
