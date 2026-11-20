# Application-owned PostgreSQL adapters

Bun.SQL and postgres.js satisfy `Postgres` from `@aotter/mantle/contracts` directly. Other drivers need `unsafe(text, values)` returning a row array with `.count` (Mantle passes a third argument, `{ prepare: true }`, which an adapter may ignore), and `begin(options, fn)` pinning one connection until the callback resolves and COMMIT succeeds. Preserve native SQLSTATE/severity evidence; generated writes classify uncertain commits.

This node-postgres adapter accepts an app-owned `pg.Pool` through its structural shape:

```ts
import type { Postgres } from '@aotter/mantle/contracts';

type Connection = {
  query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
// Pass a node-postgres Pool; its connections and lifetime stay app-owned.
export function nodePostgres(pool: Connection & {
  connect(): Promise<Connection & { release(discard?: boolean): void }>;
}): Postgres {
  const unsafe = (connection: Connection): Postgres['unsafe'] => async (text, values) => {
    const result = await connection.query(text, values);
    return Object.assign(result.rows, { count: result.rowCount });
  };
  return {
    unsafe: unsafe(pool),
    async begin(options, fn) {
      if (!/^isolation level (serializable|repeatable read|read committed|read uncommitted)$/.test(options))
        throw new Error('Unsupported transaction options');
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query(`BEGIN ${options}`);
        const tx: Postgres = {
          unsafe: unsafe(client),
          begin: async () => { throw new Error('Nested transactions are unsupported'); },
        };
        let value;
        try { value = await fn(tx); }
        catch (error) {
          try { await client.query('ROLLBACK'); } catch { discard = true; }
          throw error;
        }
        await client.query('COMMIT');
        return value;
      } catch (error) { discard = true; throw error; }
      finally { client.release(discard); }
    },
  };
}
```

The pool stays application-owned. There is no automatic retry. A COMMIT connection failure remains an error with its original evidence; the SDK can report `OUTCOME_UNKNOWN`. Adapters without interactive transactions must reject in `begin` before invoking the callback. They cannot run multi-statement Procedures or multi-write batches by independent autocommit calls.

Test on disposable storage with the [adapter conformance corpus](../../../packages/mantle/scripts/postgres-adapter.ts), covering bound date-time/date/JSON text, SELECT and RETURNING timestamp microseconds,
row arrays/counts, safe and unsafe int8 precision (including int64 extrema), aliased
selected-page integer/version number-or-string outputs, native numeric text and
booleans, unique/OCC failures, commit/rollback, nested handles and uncertain outcomes. This is an application-owned adapter, not an additional supported driver. Mantle's supported PostgreSQL drivers are Bun.SQL and postgres.js.

## PGlite

[PGlite](https://pglite.dev) is PostgreSQL compiled to WebAssembly and run inside the application's process. With this adapter, tests and previews can run a `bun-postgres` or `cloudflare-postgres` app's generated SQL on real PostgreSQL without a server. Like the adapter above, it belongs to the application: Mantle has no PGlite dependency, and PGlite is not one of Mantle's four tested stacks.

```ts
import type { Postgres } from '@aotter/mantle/contracts';

type Queryable = {
  query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount?: number }>;
};
// Pass a PGlite instance; its data directory and lifetime stay app-owned.
export function pglite(db: Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}): Postgres {
  const unsafe = (connection: Queryable): Postgres['unsafe'] => async (text, values) => {
    const result = await connection.query(text, values);
    return Object.assign(result.rows, { count: result.rowCount ?? null });
  };
  return {
    unsafe: unsafe(db),
    async begin(options, fn) {
      if (!/^isolation level (serializable|repeatable read|read committed|read uncommitted)$/.test(options))
        throw new Error('Unsupported transaction options');
      // PGlite sends BEGIN, COMMIT after fn resolves or ROLLBACK if it throws, and queues other queries until then.
      return db.transaction(async tx => {
        await tx.query(`SET TRANSACTION ${options}`);
        return fn({ unsafe: unsafe(tx) });
      });
    },
  };
}
```

Apply the generated `schema.sql` with `await db.exec(schema)`, then pass `pglite(db)` wherever generated code takes a `Postgres`. PGlite errors carry `code`, `severity`, `table` and `constraint`, so `23505`, `23514` and stale versions map to `CONFLICT` with no extra code.

Verified with PGlite 0.5.17 (PostgreSQL 18.7, in memory) on Node 22.23 and Bun 1.4.4:

- The conformance corpus above passes all 44 checks. It is not a package export, so it was run from an SDK checkout under Bun.
- A `bun-postgres` app generated from the purchasing example plus a Schema with a jsonb column passes against the packed SDK. The checks cover Procedure writes, a paged View read with its cursor, a unique violation, and a stale `expectedVersion` or Store `lock` as `CONFLICT`. A CHECK failure in a three-statement Procedure rolls back all three statements. Store transactions commit, roll back and apply `isolation`. Int8 values round-trip up to int64 extremes, jsonb round-trips, and declared timestamptz columns come back in Mantle's microsecond text form.

How it differs from a server:

- **One connection.** While a transaction is open, PGlite queues every other query, so concurrent transactions run one after another. Serialization failures (`40001`), deadlocks, lock waits and isolation anomalies never happen, so code that handles them is not exercised. Inside the callback, a query on the outer PGlite instance waits forever; Mantle already refuses its own outer handle there (`INPUT_VALIDATION_FAILED`).
- **int8 values.** PGlite returns a number, or a `bigint` above 2^53. postgres.js returns text. Generated row types allow both, and Store `version` and the REST/MCP wire modules convert them, so every check passed either way. To get postgres.js's text, for example to `JSON.stringify` bare rows, create the instance with `parsers: { 20: text => text }` (20 is int8's type OID). Numeric (text), json/jsonb (parsed), booleans, and `Date` for computed date-time columns match postgres.js.
- **No network.** `{ prepare: true }` is ignored. A COMMIT cannot be lost in transit, so `OUTCOME_UNKNOWN` comes only from the corpus's simulated failure.
- **Not exercised.** PGlite has one superuser role, so role grants, connection limits and timeouts are untested. Extensions such as `pg_trgm` need PGlite's own `extensions` option; this was not tried. Browser use and persisted data directories (IndexedDB or a file system) were not verified.

The driver layer is open; [dialects remain postgres and sqlite only](../concepts/runtime-and-adapters.md#drivers-and-dialects).
