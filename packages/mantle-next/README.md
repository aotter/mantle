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
Import a selected function from `views/<encoded-name>.ts` or
`procedures/<encoded-name>.ts` (default export, with Input/Row or Input/Output
types) to exclude other operations from the request bundle. Apply initial DDL explicitly to an
empty development database; this artifact is not a destructive migration or a
production convergence tool. Generation does no database I/O. Application code
passes driver-ready parameters, a database handle (Bun.SQL `SQL` for PostgreSQL, `bun:sqlite`
Database, D1 binding) and a verified
Caller to `views[name](db, caller, input)` or
`procedures[name](db, caller, input)`.

Default queries contain no validator, scalar decoder, row projection or generic
database-error wrapper. Validate untrusted input before calling them; redact
native errors at application transports. JSON binds are JSON text; SQLite bool,
date, timestamp and fixed numeric binds use native storage values. Bound fields
must be supplied explicitly (null for absence). Rows use SQL names and official
driver representations, including PG Date/int8 strings. No cross-DB conversion
is promised.

Use `--checked` (or `checked: true` in generateFromSources) to additionally emit
`checked.ts` and `checked/views` / `checked/procedures` for the former defaults,
validators, codecs and safe failure envelopes. These are separate generated SQL
entries and never enter bare imports. CLI regeneration disables stale owned
checked modules; API output writers must handle obsolete artifacts themselves.

The first slice provides **full-result SQL functions**, not the old paginated
View API. SQL Procedures return their existing `{ results }` shape and retain
row expectations inside native atomic transactions. A single-statement Procedure
is one atomic statement and runs without BEGIN/COMMIT (one PG round trip); a
multi-statement Procedure uses SERIALIZABLE on PG through `begin()`, with no
automatic retries. Never assume a lost commit answer means rollback after
OUTCOME_UNKNOWN; reconcile first.

PostgreSQL drivers other than Bun.SQL implement the two-method `Postgres` shape
from `@aotter/mantle-next/contracts`. For node-postgres on Workers/Hyperdrive,
see `tests/apps/pg-port.ts`: hand it one connected Client per request; `begin`
must keep every statement on that client and COMMIT only after the callback. In selected checked entries, output validation runs after commit, as in
0.2. Bare queries return native results directly. Before/after hooks, guarded/ref handlers and Triggers are not implemented;
declarations requiring them fail generation. See the complete
[compatibility ledger](../../docs/next/compatibility.md).

There is no old-runtime fallback, request-time plan verification, dynamic query
compiler, custom pool, lock polling or hook sandbox. Scalar parsing and boundary
validation are explicit checked contracts. Known output
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
See the [measured evidence and remaining performance goal](../../docs/next/performance.md).
The [size and startup gates](../../docs/next/size-and-startup.md) distinguish
the passing package/bundle gates from pending startup CPU acceptance. The local
checked-slice D1 process CPU watchdog failed; the revised native local watchdog
passed. Pure module CPU and formal equivalence remain open. The packed generator also still needs
its workspace compiler dependency made standalone before publication.
This package is not a released replacement for Mantle 0.2.
