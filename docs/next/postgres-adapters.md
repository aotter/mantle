# Application-owned PostgreSQL adapters

Bun.SQL and postgres.js already satisfy `Postgres`. Other drivers implement
`unsafe(text, values)` returning the row array with its affected-row `.count`,
and `begin(options, fn)` that pins one connection until the callback resolves
and COMMIT succeeds. A rejected callback must roll back. Preserve native server
errors, including SQLSTATE (`errno` on Bun.SQL, `code` on postgres.js) and severity;
the write-outcome classifier uses this evidence to distinguish rollback from an
uncertain commit.

The reusable check is exported from
[`packages/mantle-next/scripts/postgres-adapter.ts`](../../packages/mantle-next/scripts/postgres-adapter.ts)
beside `verify-native.ts`. It stays out of the installed request package. Run it
with Bun 1.3.14 from a built SDK checkout, or import it in the Cloud adapter's
test workspace. Its factory returns `{ db, close, interactive? }`; `close`
must dispose every connection and the isolated schema/database. **Use disposable
storage**: the checker creates generated tables and writes synthetic data.

```ts
import { verifyPostgresAdapter } from "./packages/mantle-next/scripts/postgres-adapter.js";

await verifyPostgresAdapter(async () => ({
  db: await openDisposableAdapter(),
  close: async () => { await disposeAdapterAndDatabase(); },
}));
```

The check executes generated View and Procedure entries. It covers bound date-time,
date and JSON text; declared SELECT and RETURNING timestamp microseconds; row
array/count; safe and unsafe int8 precision; numeric text and booleans; unique
violations and zero-row writes; commit, rollback and nested handles; and uncertain
COMMIT classification. It does not compare latency or perform cloud provisioning.

Declared date-time outputs are SQL-formatted ISO UTC strings with six fractional
digits. A computed timestamp, including `CAST(at AS timestamptz)`, stays native:
Bun.SQL/postgres.js may return a `Date`, which retains milliseconds. A timestamp
loss in a declared SELECT or RETURNING column fails this check; a loss in the
computed native `Date` follows the documented query contract. A Neon adapter must
run the same check before claiming either behaviour on its driver.

An HTTP-only adapter may have no interactive transactions. It must refuse in
`begin` **before invoking the callback**, with an actionable status-bearing error:

```ts
import { ContractError } from "@aotter/mantle-next/contracts";

const db = {
  unsafe: httpUnsafe,
  begin: async () => {
    throw new ContractError("TRANSACTION_UNSUPPORTED",
      "This adapter has no interactive transactions; use a transactional PostgreSQL adapter.",
      "store/transaction", { status: 400 });
  },
};
await verifyPostgresAdapter(async () => ({ db, close: dispose, interactive: false }));
```

That variant verifies multi-statement Procedures, multi-write `store.batch`, and
`store.transaction` all reject without an `unsafe` call. Reads and single-statement
writes (including a one-write batch) keep their native autocommit path. An adapter
must never emulate an interactive transaction by executing each callback query
independently over HTTP.

The SDK CI runs this corpus on real PostgreSQL with both Bun.SQL and postgres.js:

```sh
MANTLE_NEXT_BUN_PG_URL=postgres://localhost/disposable \
  bun test packages/mantle-next/tests/postgres-adapter.test.ts
```

Declared integer outputs are now safe numbers or exact large decimal strings on
every target, via generated SQL before any driver rounding. The corpus verifies
both signs and int64 extrema through generated Views and Store reads. Keep the
default JSONB scalar parser: it returns the PG projection as number/string.
Computed raw int8 and numeric outputs remain native; the same corpus verifies
that the adapter does not round their exact strings. Manifest number fields use
real/float8 and stay numbers; bare booleans keep SQLite/D1 0/1 versus PG boolean.
Regenerate and typecheck consumers after switching a target; narrow integer rows
before arithmetic or use BigInt, never blindly Number a large decimal string.
