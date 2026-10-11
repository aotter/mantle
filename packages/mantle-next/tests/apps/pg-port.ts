/** node-postgres behind the Bun.SQL shape (`Postgres`). Hand it one checked-out Client: begin() keeps its statements there. */
import type { ClientBase } from "pg";
import type { Postgres } from "../../src/kernel/contracts.js";

export function pgPort(client: ClientBase): Postgres {
  const port: Postgres = {
    unsafe: async (text, values) => {
      const result = await client.query({ text, values });
      // Non-enumerable, so the rows still compare and serialize as plain rows.
      return Object.defineProperty(result.rows, "count", { value: result.rowCount }) as typeof result.rows & { count: number | null };
    },
    begin: async (options, fn) => {
      await client.query(`BEGIN ${options}`);
      let rows: unknown[][];
      try { rows = await fn(port); } catch (error) {
        // A failed ROLLBACK leaves the session unusable: surface both so the caller discards the client.
        try { await client.query("ROLLBACK"); } catch (rollback) { throw new AggregateError([error, rollback], "Execution and rollback failed."); }
        throw error;
      }
      await client.query("COMMIT");
      return rows;
    },
  };
  return port;
}
