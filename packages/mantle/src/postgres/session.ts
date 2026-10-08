/**
 * A request is the unit of work (#1379). `requestScoped(connect)` gives one `PgConnect` to every PostgreSQL consumer of a
 * service (the Store, Better Auth's `pgPool`, auth's `pgDatabaseDriver`) and a `run` the host wraps each request in: inside
 * it, every operation reuses one client, opened by the first and ended when the request ends, as a Worker's socket must be.
 * Outside it (boot, a schedule, work that outlives its request) each operation opens its own client, as before.
 *
 * One operation holds the shared client from its `connect()` to its `end()` (a write from BEGIN to COMMIT), so two never
 * interleave inside each other's transaction. One that arrives while it is held opens a client of its own instead of waiting:
 * waiting would deadlock a caller that queries outside a transaction it holds open, and a request with no concurrency (the
 * common one) still uses a single connection.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sqlState, type PgClient, type PgConnect } from "./driver.js";

export interface PgSession {
  /** What `postgresStorage`, `pgPool` and `pgDatabaseDriver` take. */
  readonly connect: PgConnect;
  /** Runs `fn` as one request: its operations share one client, ended when `fn` settles (or, if one is in flight, after it). */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

interface Scope {
  open: boolean;
  busy: boolean;
  client?: Promise<PgClient>;
}

// for a client that does not report the protocol's transaction state: what the SQL text says
const BEGINS = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const ENDS = /^\s*(COMMIT|ROLLBACK|END|ABORT)\s*(;|$)/i;
const close = (c: Promise<PgClient> | undefined) => void c?.then((x) => x.end()).catch(() => undefined);

export function requestScoped(connect: PgConnect): PgSession {
  const als = new AsyncLocalStorage<Scope>();

  const release = (scope: Scope, discard: boolean) => {
    if (discard || !scope.open) {
      close(scope.client);
      scope.client = undefined;
    }
    scope.busy = false;
  };

  /**
   * The shared client for one operation. Its `end()` hands it back; one left in a transaction, by the protocol's own report
   * when the driver gives it (node-postgres) or else by the SQL it ran, or with a broken socket, is closed.
   */
  const lease = (scope: Scope, client: PgClient): PgClient => {
    let inTx = false;
    let broken = false;
    let released = false;
    const track = <T>(text: string, p: Promise<T>): Promise<T> => {
      if (BEGINS.test(text)) inTx = true;
      // an answer to COMMIT or ROLLBACK, even an error, ends the transaction; an error with no SQLSTATE is the socket's
      p.then(() => { if (ENDS.test(text)) inTx = false; }, (e) => { if (!sqlState(e)) broken = true; else if (ENDS.test(text)) inTx = false; });
      return p;
    };
    return {
      pipeline: client.pipeline,
      ...(client.execute ? { execute: (s) => track(s.text, client.execute!(s)) } : {}),
      query: ((config: string | { text: string }, values?: readonly unknown[]) =>
        track(typeof config === "string" ? config : config.text, (client.query as (c: unknown, v?: unknown) => Promise<never>)(config, values))) as PgClient["query"],
      async end() {
        if (released) return;
        released = true;
        // ponytail: a transaction left open is closed with its client rather than rolled back here, which costs the request a
        // reconnect only on a path that already failed
        const status = client.getTransactionStatus?.();
        release(scope, broken || (status != null ? status !== "I" : inTx));
      },
    };
  };

  return {
    async connect() {
      const scope = als.getStore();
      if (!scope?.open || scope.busy) return connect();
      scope.busy = true;
      try {
        if (!scope.client) {
          const shared: Promise<PgClient> = connect().then((c) => {
            // a socket that fails while the client sits idle between operations: the next one opens another, and node-postgres
            // does not throw the event for want of a listener
            (c as { on?(event: "error", f: () => void): unknown }).on?.("error", () => {
              if (scope.client === shared) scope.client = undefined;
              void c.end().catch(() => undefined);
            });
            return c;
          });
          scope.client = shared;
        }
        return lease(scope, await scope.client);
      } catch (e) {
        scope.client = undefined;
        scope.busy = false;
        throw e;
      }
    },
    async run(fn) {
      const scope: Scope = { open: true, busy: false };
      try {
        return await als.run(scope, fn);
      } finally {
        scope.open = false;
        // not awaited: ending a client waits for the server to close the socket, which the response need not wait for
        if (!scope.busy) release(scope, true);
      }
    },
  };
}
