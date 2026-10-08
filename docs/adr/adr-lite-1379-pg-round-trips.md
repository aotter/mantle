# ADR-lite #1379: one round trip per PostgreSQL operation

Status: Proposed under #1379.

Date: 2026-10-08.

Amends: ADR-0035's PostgreSQL amendment ("statements are sent one at a time")
and ADR-0038's result description (the `TEMPORARY` privilege).

## Context

The PostgreSQL dialect runs on two hosts: Workers behind Hyperdrive (ADR-0036)
and Bun with a native pool (ADR-0038). Mantle Cloud plans to move Control's own
database from D1 to PostgreSQL behind Hyperdrive. An on-premises single-org
deployment will run the same plan on Bun and PostgreSQL. Both hosts must be fast
enough for a control plane's hot paths, such as per-request route reads and
multi-statement guarded writes.

Opening a connection is not the problem. On Workers, `connect` builds a `pg`
client against Hyperdrive, which already holds pooled origin connections. On
Bun, `connect` reserves a connection from `Bun.SQL`'s pool. The cost is the
number of network round trips per operation:

| Operation | Today | Where |
|---|---|---|
| Read (`query`) | 3: `BEGIN READ ONLY` + pins, the read, `COMMIT` | `postgres/driver.ts` `query` |
| Write batch of N statements (`transaction`) | N + 2: `BEGIN SERIALIZABLE` + pins, each statement, `COMMIT` | `postgres/driver.ts` `transaction` |
| Read on Bun | about 7: the above plus `CREATE TEMP TABLE … WITH NO DATA`, `pg_attribute`, `DROP`, `SET TRANSACTION READ ONLY` | `bun/index.ts` `execute` |

D1 runs a whole batch in one call. Moving a plan from D1 to PostgreSQL should not
multiply its latency by the number of statements, and a guarded batch such as a
13-statement cascade delete should cost the same as a one-statement write.

Each statement waits for the one before it for two reasons:

1. `pg` (node-postgres) does not pipeline. It sends a query only after the
   previous one is ready.
2. The executor checks each write's `expect` count in JavaScript between
   statements (`postgres/executor.ts` `apply`). This is the only data the next
   statement waits for. Every statement in a batch is compiled before the batch
   starts, so no statement depends on a previous statement's rows.

Bun takes extra round trips because `Bun.SQL` does not expose RowDescription
type OIDs and typmods. The host describes each result through a temporary table,
which also forces every Bun role to hold `TEMPORARY` on the database.

## Decision

### 1. Every read and every write batch is one pipelined round trip

- The driver sends the transaction as one extended-protocol pipeline: `BEGIN`
  (`READ ONLY` for a read, `ISOLATION LEVEL SERIALIZABLE` for a write), the pinned
  settings, every statement, then `COMMIT`. A single `Sync` follows them.
- If a statement fails, PostgreSQL discards everything up to the `Sync`, so the
  transaction applies nothing. All-or-nothing semantics, the pinned `SET LOCAL`s,
  the statement timeout, and Hyperdrive's cache bypass for reads in a transaction
  all stay the same.
- A serialization failure (40001/40P01) still retries the whole batch, up to the
  same attempt limit. Each attempt is one round trip.
- The failing statement's index comes from which pipelined result reports the
  error. Diagnostics keep `opIndex`, and an error during `COMMIT` keeps
  `committing: true`.

### 2. `expect` is checked by PostgreSQL, inside the statement

- A write that carries `expect` is printed so the database raises when the count
  differs. The write gets a `RETURNING` clause, wrapped in a CTE, and an
  always-evaluated one-row guard calls
  `_mantle_expect(actual bigint, expected bigint)`. That function is installed by
  convergence alongside the existing `_mantle_*` functions.
- The function raises with a Mantle-reserved SQLSTATE. The executor maps it to
  the same `CONFLICT op=i … reason: "expect"` diagnostic it produces today.
- The guard must fire when zero rows matched. A guard placed in a `WHERE` over the
  written rows is never evaluated on zero rows, so that form is forbidden. The
  conformance cases pin 0, fewer, and more rows than expected.
- The same mechanism gives `handler.sql` set operations an opt-in abort-on-zero,
  a gap the Control migration needs.

### 3. One driver on both hosts: a pipelining port

- `PgConnect`/`PgClient` gains a pipelined call, sketched as
  `pipeline(statements, { readOnly, timeoutMs }) → outcomes | error at index`.
  The host supplies a client that implements it.
- The reference implementation uses postgres.js (`postgres`). It pipelines, it
  returns column type OIDs from RowDescription, and it runs on both Workers with
  Hyperdrive and Bun. A single implementation replaces `pg` on Workers and the
  `Bun.SQL` shim on Bun.
- The temporary-table result description and the `TEMPORARY` grant are removed.
- `pgPool` (Better Auth through Kysely) is unchanged. Auth's own transactions are
  outside this decision.

## Consequences

- With a PostgreSQL dialect, reads and write batches cost one round trip on both
  hosts, plus one for each serialization retry. Latency to the database becomes
  the cost model, as it is on D1.
- Bun roles no longer need `TEMPORARY`, so ADR-0038's grant note is withdrawn.
- `PgConnect`'s shape changes. Generated host entries (`cli/preset.ts`,
  `cli/generate.ts`) and the handbook's Hyperdrive and Bun pages change with it.
  This is a `breaking-change` for anyone who composes `postgresStorage` by hand.
- PostgreSQL error positions arrive per pipelined message instead of per awaited
  call, so the executor's error mapping is rewritten against the new shape.
- Convergence's DDL transactions run once at boot. They may keep the simple path.

## Alternatives

- **Keep `pg` and check `expect` before `COMMIT`.** Pipeline everything except
  `COMMIT`, check the counts in JavaScript, then send `COMMIT` or `ROLLBACK`.
  This takes 2 round trips and needs no server-side guard. It is rejected as the
  end state, but it is the fallback if the guard proves fragile.
- **One statement per batch through data-modifying CTEs.** Rejected. Every CTE
  sees the same snapshot, so a later statement does not see an earlier statement's
  writes, and batch semantics would change.
- **Server-side batch function (`EXECUTE … USING` over a JSON batch).** Rejected.
  It moves the whole batch into dynamic SQL, loses per-parameter types, and widens
  what the database executes on Mantle's behalf.
- **Infer result types from the plan to keep `Bun.SQL`.** Rejected. Expressions
  such as `CASE`, `COALESCE`, CTEs, and folded constants get their types from
  PostgreSQL. The temporary-table describe exists because the plan cannot know
  them all.
- **Read outside a transaction.** Rejected. Hyperdrive answers a read outside a
  transaction from its cache, and the pinned settings need `SET LOCAL`. This could
  be revisited only for a Hyperdrive configuration with caching disabled.

## How to apply

1. Add a round-trip counting transport to the PostgreSQL conformance engine
   (`test/postgres/engine.ts`) and assert:
   - a read takes 1 round trip;
   - a write batch takes 1 round trip at any N;
   - a 40001 retry adds exactly 1;
   - failure at statement i rolls everything back and reports `opIndex: i`;
   - an `expect` mismatch with 0, fewer, and more rows maps to `CONFLICT`;
   - a `COMMIT` failure reports `committing`.
2. Implement the pipelined `PgClient` over postgres.js. Confirm it exposes the
   typmods that `decodeField` reads. If it does not, decode from OIDs plus the
   plan's declared column types, and keep the describe only for the expressions
   that need it. Run the existing dialect,
   reference, and JSON round-trip suites over it, and over the Bun host
   (`test/bun/native.ts`).
3. Print `expect` guards and install `_mantle_expect` with convergence.
4. Switch the generated Workers (Hyperdrive) and Bun entries, then remove the
   temporary-table describe and the `pg` dependency.
5. In the alpha host matrix (`scripts/alpha-matrix`), run against a real
   Hyperdrive binding and confirm that Hyperdrive forwards a pipelined transaction
   intact. Its documentation confirms transaction-mode pooling and the extended
   protocol, but does not state pipeline behavior. If it does not forward the
   pipeline intact, the Workers host falls back to the 2-round-trip alternative,
   and the record says so.

## Implementation status

Proposed. Nothing implemented.
