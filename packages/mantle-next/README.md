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

Outputs are `generated.ts` and `schema.sql`. Apply initial DDL explicitly to an
empty development database; this artifact is not a destructive migration or a
production convergence tool. Generation does no database I/O. Application code
passes an official connected client/SQLite handle/D1 binding and a verified
Caller to `views[name](db, caller, input)` or
`procedures[name](db, caller, input)`.

The first slice provides **full-result SQL functions**, not the old paginated
View API. SQL Procedures return their existing `{ results }` shape and retain
row expectations inside native atomic transactions. PG uses SERIALIZABLE with
no automatic retries. The application owns PoolClient checkout/release or
Client connect/end. Discard the client after OUTCOME_UNKNOWN; never assume a
lost commit answer means rollback. Output validation runs after commit, as in
0.2. Before/after hooks, guarded/ref handlers and Triggers are not implemented;
declarations requiring them fail generation. See the complete
[compatibility ledger](../../docs/next/compatibility.md).

There is no old-runtime fallback, request-time plan verification, dynamic query
compiler, custom pool, lock polling or hook sandbox. Scalar parsing and boundary
validation are retained because they are observable contracts. Known output
names and bindings are emitted as straight-line code. Per-query PG wire metadata
is needed for computed SQL values whose native type is only known from the result.

PostgreSQL resources are an explicit trusted application/deployment boundary.
Generated PG modules export `postgresRequirements`, plain native GUC defaults:
DateStyle ISO/YMD, IntervalStyle postgres, TimeZone UTC,
standard_conforming_strings on, extra_float_digits 1, statement_timeout 10000ms.
Configure these through PostgreSQL's native ROLE or DATABASE settings before
serving queries. Any ISO date order, float precision >= 1 and stricter positive
timeout satisfy the same prerequisites. An explicit unbounded timeout is an
application policy decision, as the previous adapter's timeout=0 was. Bun may
also use official driver connection options where session lifetime permits.
Hyperdrive resets pooled sessions: do not assume client SETs/startup options
persist on its origin sessions. The generated functions neither configure nor
verify every connection; deployment owns this precondition just as it owns the
verified Caller and initial schema. No per-read settings query is added.

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
Worker `performance.now()` advances with I/O events and cannot account reliably
for row processing after an await. Its per-call samples are I/O-event intervals,
not complete function latency. Assess Worker overhead with an external host clock,
paired batches consuming the same complete rows, and a native/native control;
report HTTP and connection amortization separately. Local Wrangler results do not
establish deployed Cloudflare latency.
This package is not a released replacement for Mantle 0.2.
