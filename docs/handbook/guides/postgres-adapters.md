# Application-owned PostgreSQL adapters

Bun.SQL and postgres.js satisfy `Postgres` from `@aotter/mantle/contracts` directly. Other drivers need `unsafe(text, values)` returning a row array with `.count`, and `begin(options, fn)` pinning one connection until the callback resolves and COMMIT succeeds. Preserve native SQLSTATE/severity evidence; generated writes classify uncertain commits.

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

The driver layer is open; [dialects remain postgres and sqlite only](../concepts/runtime-and-adapters.md#drivers-and-dialects).
