# ADR-0041: Native driver execution and application-owned before hooks

**Status:** Accepted direction for issue #1426; implemented by its cleanup PR.

**Date:** 2026-10-10

**Amends:** ADR-0032/0034 before-hook restrictions and implicit hook OCC;
ADR-0038 SQLite shared-handle waiting; ADR-0039 request scoping and pipelining.
Clarifies ADR-0040. Scope, visibility, explicit OCC, publishing checks, atomic
write batches and validation at trust boundaries remain required.

## Context

The request-scoped PostgreSQL session wraps native acquisition with an
AsyncLocalStorage scope, busy-client fallback, transaction-state tracking and
listener ownership. Its fetch scope ends before delayed response consumption.
The write driver adds a custom pipeline and serialization/deadlock retry loop.
The Bun SQLite adapter routes reads through immediate write transactions and
polls when another transaction holds its handle.

These are responsibilities the native drivers already expose directly, or
consequences of an unsuitable resource composition. Optimizing the wrappers
with another queue, pool or streaming manager would keep that responsibility
in Mantle. Before-hook runtime policing similarly attempts to make arbitrary
application code safe through a read-only facade and implicit version pinning.

## Decision

### Native database operations

- PostgreSQL uses official node-postgres `Client` and `Pool`. Bun owns one
  native Pool for its application lifetime; Workers opens native Clients for
  operations within the platform-supported lifetime. There is no Mantle
  request session, second pool, SQL-text state tracker or query scheduler.
- A PostgreSQL atomic batch acquires one client and executes native
  `BEGIN ISOLATION LEVEL SERIALIZABLE`, statements and `COMMIT` sequentially.
  SERIALIZABLE is an explicit PostgreSQL guarantee, not SQLite emulation.
  There is no custom pipeline or automatic retry/backoff. A serialization or
  deadlock failure is surfaced; application authors decide reconciliation.
- Native PoolClients are returned with `release`; standalone Clients are
  closed with `end`. Rollback is attempted after failure. Failed rollback,
  socket failure and uncertain commit discard the pooled client. Losing a
  COMMIT answer is `OUTCOME_UNKNOWN`, not proof that nothing was written.
- SQLite reads use native cached queries through the existing `all`/`first`
  seam, without an immediate write transaction or Mantle lock polling. Atomic
  batches still use the native transaction API. Calls on a handle already
  inside an asynchronous transaction fail promptly: no dirty-read promise or
  independently committed savepoint can be fabricated.
- An authenticated Bun SQLite preset opens two native handles to the same
  file in WAL mode: Store and ancillary auth SQL use `DB`; Better Auth
  exclusively owns `AUTH_DB`. Better Auth owns its own transaction/mutex behavior; Mantle
  adds no coordinator. The two-handle composition rejects `:memory:` because
  independent memory handles are different databases. Native SQLite locks
  and busy behavior remain native; Mantle adds no wait/retry loop.
- D1 uses native bindings. Its reads use native `all` rather than a one-item
  batch. No claim is made about cloud RTT or identical SQLite/PG behavior.

### Better Auth's supported integration

Follow the official [PostgreSQL](https://better-auth.com/docs/adapters/postgresql)
and [SQLite](https://better-auth.com/docs/adapters/sqlite) adapters: Bun passes
the native Pool or Database directly. Enable official
`advanced.database.joins: true`, rather than hand-building session/user joins
or introducing a session cache. Fresh-role enforcement remains required.
The existing schema check still runs after Mantle storage convergence; this
does not replace Better Auth's validation.

Sharing a native PostgreSQL Pool shares capacity, not one checked-out client
or an atomic transaction across Auth and Store. Each transaction keeps one
client as [node-postgres documents](https://node-postgres.com/features/transactions).
Default PostgreSQL Read Committed already prevents dirty reads; the retained
SERIALIZABLE write-batch contract is separate. [SQLite documents](https://www.sqlite.org/isolation.html)
that operations on the same connection see its uncommitted changes, while
separate connections provide native isolation. The composition does not
enable shared cache or `read_uncommitted`.

The official [database hook contract](https://better-auth.com/docs/concepts/database#database-hooks)
executes after hooks after transaction commit. Ancillary bootstrap and
fresh-role SQL use the separate Store handle, observing committed data without
bypassing Better Auth's connection mutex. Two SQLite handles are Mantle's explicit native
Store/Auth isolation choice, not a Better Auth requirement. Hyperdrive
pooling belongs to Cloudflare; [its official pg example](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
uses a native Client within the Worker request lifetime. No additional pool
or adapter package is introduced by this cleanup.

### Application-owned hooks

- Before hooks receive their declared visible-row or insert-value event
  snapshot, in declared execution order. The snapshot is an observation,
  not a protected application transaction.
- A before handler receives the normal caller-bound Store and nested
  invocation capability. Each operation still enforces policy and auth;
  nested invocation preserves caller, cause and the existing depth limit.
- Mantle no longer injects a version predicate solely because a before hook
  exists. An explicitly authored OCC predicate remains enforced. Publishing
  retains its separately declared state/full-entry checks and associated
  version protection.
- A hook that throws prevents the outer batch from executing. Writes the
  hook already committed independently remain committed. A later hook may
  see data changed by an earlier hook. Authors own handler side effects,
  correctness, races and error recovery. Use native constraints and authored
  SQL/transactions when the business rule must be atomic.
- Authorization guards retain their separate read-only/no-invoke contract.
  Removing a before-hook sandbox does not remove an authorization boundary.
- Authoring validation checks known references and declared shapes. Incoming
  runtime plans and API inputs remain validated. Neither validation stage
  claims to prove arbitrary JavaScript behavior; no hook analyzer or new
  manifest configuration is added.

### Independent database targets

Each dialect preserves its own syntax, ordering, NULL placement, collation,
index planner and native transaction behavior. Authors own the target's
query semantics, unique cursor order and application indexes. Mantle fixes
lowering bugs but does not compensate for unspecified application
preconditions with extra queries, hidden keys or normalization layers.

## Consequences and migration

This is a breaking cleanup. Existing generated application source is owned by
the application; it is not silently overwritten. Replace `requestScoped` and
`PgSession` wiring with native acquisition/release and pass the Bun native
Pool directly to Better Auth. Remove generated `pipeline: true`, custom
listener registries and request wrappers. Reconcile native transaction errors
explicitly rather than relying on automatic retries.

For Bun SQLite, add the separate `AUTH_DB` file handle for Better Auth alone.
Keep its ancillary SQL driver on Store `DB`. Both handles must point at the same file;
close both after the server and retained work stop. An application embedding
one handle must ensure it is not shared across asynchronous transactions.

Before-hook authors who relied on sandboxed writes or implicit version
protection must move atomic conditions into SQL/constraints or declare OCC.
Do not assume a failed outer mutation reverses earlier hook side effects.
Publishing and explicit caller OCC are not removed by this migration.

Workers per-operation connection counts and sequential write latency may
increase. That is an explicit ownership tradeoff, not a reason to restore a
manager. Validation measures actual query messages, native transactions,
checkouts, physical connections and local wall time independently on four
applications; it does not assert identical values/performance across engines.

## Alternatives

Rejected: another request queue, stream-scope lifecycle wrapper, custom pool,
lock polling, retry scheduler, cross-engine emulation or JavaScript hook
side-effect analyzer. The existing seams and native APIs are sufficient.

## How to apply

Follow the [consumer migration](../handbook/guides/native-execution.md),
regenerate into a scratch directory and copy the native ownership changes.
Run four local applications, native transaction/error tests, handler/guard
regressions and the repository checks. Review scope against issue #1426.

## Implementation status

The cleanup PR implements this decision; deployment and release are separate
operations. Schema convergence retains its existing advisory-lock/migration
contract. Local evidence does not establish cloud Hyperdrive behavior.
