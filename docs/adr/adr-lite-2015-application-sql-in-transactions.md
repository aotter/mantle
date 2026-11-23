# ADR-lite: Application SQL in a Store transaction

**Status:** Accepted, issue #2015. Amends the transaction rules of [ADR-0045](0045-next-runtime-core.md); adds no
subpath and no grammar.

## Context

An application on PostgreSQL (in production on `cloudflare-postgres` through Hyperdrive) needs one interactive
transaction that mixes its own SQL (a transaction advisory lock, writes to tables outside the manifest) with generated
Procedures, committed together at a chosen isolation. Since 0.2.2-alpha.2 (#1967) the only way was
`transaction` from `@aotter/mantle/internal/driver/postgres`, which is generated-code plumbing with no promise. A
hand-written `db.begin(...)` does not work: the driver does not know that handle is a transaction, so a multi-step
Procedure given it opens a nested BEGIN, which the client refuses or runs outside it.

The generated Store's `transaction` already opens a transaction through the driver, registers its handle so generated
Procedures join it, maps `40001`/`40P01` to `CONFLICT` and a lost COMMIT answer to `OUTCOME_UNKNOWN`, guards against the
outer handle, and passes the raw transaction handle to its callback as an undeclared second argument. A ref handler's
`ctx.transaction(({ store, db }) => …)` already declares that handle.

Reading the source also showed a gap: a generated multi-statement Procedure that joined a transaction and failed after
an earlier statement wrote (for example a stale-version `UPDATE` after an `INSERT`) left that write in the transaction.
If the caller caught the error, the transaction committed half of the Procedure. On bun:sqlite the same held. Bun.SQL
1.4 reported a COMMIT of an aborted transaction as `OUTCOME_UNKNOWN`, although the server had answered ROLLBACK, and
Bun.SQL 1.3 reported it as committed.

## Decision

1. **Declare the handle.** The Store's `transaction(fn, options)` types `fn` as `(tx, db: H) => Promise<R>`, where `H`
   is the handle type the generated `store` takes (`Postgres` from `@aotter/mantle/contracts`, or the bun:sqlite
   `Handle`). This is a type change only; the runtime already passed it. The documented example needs no `internal/`
   import and no cast.
2. **No public PostgreSQL driver module.** `@aotter/mantle/internal/driver/postgres` stays plumbing and keeps its path so
   generated code and existing applications keep working. A public `transaction(db, fn, { isolation })` would be a
   second entry point to the same driver function with weaker rules (no outer-handle guard, no Store), would reopen the
   subpath #1967 deliberately closed, and would need a Caller-free path the Store transaction does not.
3. **A failed multi-statement Procedure makes a joined transaction rollback-only**, as a failed batch already did. Both
   transaction drivers record the first such failure on the transaction handle, and the transaction throws it instead
   of committing. A failed single statement changed nothing and does not poison it.
4. **A failed PostgreSQL statement makes the transaction rollback-only before COMMIT.** PostgreSQL has aborted it, but
   Bun.SQL 1.3 (the version CI pins) resolves a COMMIT the server answered with ROLLBACK, and neither client notices a
   statement that failed after the callback returned. The transaction handle waits for every statement it ran and
   throws the first failure instead of committing; a generated call's mapped error (`CONFLICT`) replaces the native
   error it wraps. Bun.SQL 1.4's `ERR_POSTGRES_COMMIT_ROLLED_BACK`, raised only when the server answered COMMIT with
   ROLLBACK, is also a definitive rollback, not `OUTCOME_UNKNOWN`.
5. **A ref handler's `ctx.transaction` joins by handle**: it joins the open Store transaction whose handle it was given,
   also through a Store or generated call built from the declared `db`, instead of refusing a nested one.

Raw SQL on the handle runs with the database role's rights, outside the Caller, scope, TTL, publishing and system-column
rules and outside `authorize`; generated code in the same transaction keeps its rules. The handbook says so beside the
example.

## Consequences

- One documented PostgreSQL transaction surface for applications: the generated Store's. Parity for `bun-postgres` and
  `cloudflare-postgres` comes from the one driver both targets generate against.
- An application that catches a joined multi-statement Procedure's failure and expected the transaction to commit now
  gets a rejection. That commit was a partial Procedure, so this is a fix, recorded in the release notes.
- Hyperdrive behaviour (one connection per transaction, no session state between transactions) is Cloudflare's and is
  documented as guidance; the tests run in workerd against Wrangler's local Hyperdrive binding, which connects directly.

## Acceptance

- `tests/postgres-transaction.test.ts`: the documented example typechecks from public imports on both PostgreSQL
  targets and bun:sqlite, and D1 has no `transaction`; the scenarios run on Bun.SQL and postgres.js and fail without
  decisions 3 or 4 (decision 4 also on Bun 1.3.14); `tests/handlers.test.ts` fails without decision 5.
- `scripts/verify-native.ts` runs the same scenarios on `bun-postgres` and inside workerd for `cloudflare-postgres`.
