/**
 * The PostgreSQL connection port. Structural types of node-postgres (`pg`), so Mantle depends on no driver: the host passes
 * `connect`, which opens one client (`new Client(env.HYPERDRIVE.connectionString)` on Workers, where Hyperdrive pools the
 * connections and a socket must not outlive its request). Every operation opens a client and ends it.
 *
 * A client that pipelines (node-postgres `new Client({ pipeline: true })`) gets every statement of an operation, BEGIN and
 * COMMIT included, written before the first answer is read: one round trip per read or write batch. Without it, statements are
 * sent one at a time (N + 2 round trips per batch).
 */
import type { DatabaseDriver, SqlResult, SqlStatement } from "../core/driver.js";
import { decodeField } from "./codec.js";

export interface PgField { readonly name: string; readonly dataTypeID: number; readonly dataTypeModifier?: number }
export interface PgResult { readonly rows: Record<string, unknown>[]; readonly rowCount: number | null; readonly fields: readonly PgField[] }
export interface PgClient {
  /** node-postgres pipeline mode: queries issued without awaiting share the wire. */
  readonly pipeline?: boolean;
  /** A native transport without RowDescription can execute a dialect-supplied result description. */
  readonly temporaryResultMetadata?: boolean;
  execute?(statement: PgStatement): Promise<PgOutcome>;
  query(config: { text: string; values?: unknown[]; types?: { getTypeParser(oid: number, format?: string): (text: string) => unknown } }): Promise<PgResult>;
  /** The positional form Kysely (Better Auth) calls. */
  query(text: string, values?: readonly unknown[]): Promise<PgResult & { command: string }>;
  end(): Promise<void>;
}
/** Opens one connected client. */
export type PgConnect = () => Promise<PgClient>;

/** An error PostgreSQL answered with carries its SQLSTATE in `code`; anything else (a dropped socket) carries none. */
export interface PgError extends Error { code?: string; constraint?: string; table?: string }
export const sqlState = (e: unknown): string | undefined => {
  const code = (e as PgError)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
};

// every value comes back as text and is decoded by its column's type OID (`decodeField`), never by the driver's own parsers
const RAW = { getTypeParser: () => (text: string) => text };

export interface PgStatement {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly describeResult?: () => { query: string; names: string[] | undefined } | undefined;
  /** The statement is a read: a client that had to begin read-write (to describe it) makes the transaction read-only first. */
  readonly readOnly?: boolean;
}
/** One statement's rows (decoded) and the rows it wrote or returned. */
export interface PgOutcome { readonly rows: Record<string, unknown>[]; readonly count: number }

async function run(client: PgClient, s: PgStatement): Promise<PgOutcome> {
  if (client.execute) return client.execute(s);
  const r = await client.query({ text: s.text, values: [...(s.values ?? [])], types: RAW });
  const rows = r.rows.map((row) => Object.fromEntries(r.fields.map((f) => [f.name, decodeField(f.dataTypeID, row[f.name] as string | null, f.dataTypeModifier)])));
  return { rows, count: r.rowCount ?? rows.length };
}

const SERIALIZATION = new Set(["40001", "40P01"]);
/**
 * What every wire value is decoded under, whatever the server's defaults: ISO dates, PostgreSQL interval text, shortest exact
 * floats, UTC. `SET LOCAL` inside the transaction, because Hyperdrive pools connections per transaction.
 */
const PINNED = "SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL IntervalStyle = 'postgres'; SET LOCAL extra_float_digits = 1; SET LOCAL TimeZone = 'UTC'; " +
  // pg_temp named last: a temporary table on a pooled session never stands in for a Schema table of the same name
  "SELECT set_config('search_path', concat_ws(', ', nullif(current_setting('search_path'), ''), 'pg_temp'), true)";
/** ADR-0037 decision 5: a statement that runs away (a recursive CTE, a regular expression) ends here. 0 is no limit. */
export const STATEMENT_TIMEOUT_MS = 10_000;
const pinned = (timeoutMs: number) => `${PINNED}; SET LOCAL statement_timeout = ${Math.max(0, Math.floor(timeoutMs))}`;
const ATTEMPTS = 5;

/**
 * Statements in one SERIALIZABLE transaction, all or nothing. SERIALIZABLE keeps what SQLite's one writer gave every guard
 * (`WHERE NOT EXISTS`, a first sign-up becoming owner): a concurrent write that would break one fails with 40001 and the
 * whole batch is retried. `check` runs after each statement and may throw to roll everything back.
 */
export async function transaction(connect: PgConnect, statements: readonly PgStatement[], check?: (i: number, outcome: PgOutcome) => void, timeoutMs = STATEMENT_TIMEOUT_MS): Promise<PgOutcome[]> {
  for (let attempt = 1; ; attempt++) {
    const client = await connect();
    // `check` reads an outcome before COMMIT is sent, so it needs the statements one at a time
    if (client.pipeline && !check) {
      try {
        return await pipelined(client, `BEGIN ISOLATION LEVEL SERIALIZABLE; ${pinned(timeoutMs)}`, statements);
      } catch (e) {
        if (SERIALIZATION.has(sqlState(e) ?? "") && attempt < ATTEMPTS) continue;
        throw e;
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    let failedAt = -1;
    let committing = false;
    try {
      await client.query({ text: `BEGIN ISOLATION LEVEL SERIALIZABLE; ${pinned(timeoutMs)}` });
      const out: PgOutcome[] = [];
      for (const [i, s] of statements.entries()) {
        failedAt = i;
        out.push(await run(client, s));
        failedAt = -1;
        check?.(i, out[i]!);
      }
      committing = true;
      await client.query({ text: "COMMIT" });
      return out;
    } catch (e) {
      await client.query({ text: "ROLLBACK" }).catch(() => undefined);
      if (SERIALIZATION.has(sqlState(e) ?? "") && attempt < ATTEMPTS) continue;
      // `committing`: only a failure during COMMIT leaves the outcome unknown; anything before it applied nothing
      throw Object.assign(e as object, { statement: failedAt, committing });
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

/**
 * One read on its own client, in a read-only transaction: the settings are pinned, and Hyperdrive never answers a read
 * inside a transaction from its cache, so a read sees the write before it.
 * Three round trips (BEGIN, the read, COMMIT) unless the client pipelines them as one.
 */
export async function query(connect: PgConnect, s: PgStatement, timeoutMs = STATEMENT_TIMEOUT_MS): Promise<PgOutcome> {
  const client = await connect();
  if (client.pipeline) {
    try {
      return (await pipelined(client, `BEGIN READ ONLY; ${pinned(timeoutMs)}`, [{ ...s, readOnly: true }]))[0]!;
    } finally { await client.end().catch(() => undefined); }
  }
  try {
    await client.query({ text: `BEGIN${client.temporaryResultMetadata ? "" : " READ ONLY"}; ${pinned(timeoutMs)}` });
    const out = await run(client, { ...s, readOnly: true });
    await client.query({ text: "COMMIT" });
    return out;
  } catch (e) {
    await client.query({ text: "ROLLBACK" }).catch(() => undefined);
    throw e;
  } finally { await client.end().catch(() => undefined); }
}

/**
 * BEGIN, every statement and COMMIT written at once. Each is its own Sync, so a failure leaves the transaction aborted: the
 * statements after it fail with 25P02 and COMMIT answers ROLLBACK. The first failure is the one reported, with its statement.
 */
async function pipelined(client: PgClient, begin: string, statements: readonly PgStatement[]): Promise<PgOutcome[]> {
  const settled = await Promise.allSettled([
    client.query({ text: begin }),
    ...statements.map((s) => run(client, s)),
    client.query({ text: "COMMIT" }),
  ]);
  const failed = settled.findIndex((r) => r.status === "rejected");
  if (failed === -1) return settled.slice(1, -1).map((r) => (r as PromiseFulfilledResult<PgOutcome>).value);
  const e = (settled[failed] as PromiseRejectedResult).reason;
  // a failed BEGIN may leave no transaction open; an open one is already aborted, and ROLLBACK ends it either way
  if (failed <= statements.length) await client.query({ text: "ROLLBACK" }).catch(() => undefined);
  throw Object.assign(e as object, { statement: failed >= 1 && failed <= statements.length ? failed - 1 : -1, committing: failed === statements.length + 1 });
}

/** `?1` binds (Mantle's portable SQL) as PostgreSQL's `$1`, outside quoted strings and names. */
export const numbered = (sql: string) => sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?(\d+)/g, (m, n?: string) => (n ? `$${n}` : m));

/**
 * The `DatabaseDriver` over PostgreSQL, for auth's portable SQL and the conformance fixtures: every batch is one transaction.
 */
export function pgDatabaseDriver(connect: PgConnect): DatabaseDriver {
  return {
    async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
      return (await transaction(connect, statements.map((s) => ({ text: numbered(s.sql), values: s.binds })))).map((o) => ({ rows: o.rows }));
    },
  };
}

/**
 * What Better Auth takes as a PostgreSQL pool (`database: pgPool(connect)`): Kysely's `PostgresDialect` asks it for a client per
 * query or transaction and releases it, so each gets its own connection, as the Workers rule above asks.
 */
export function pgPool(connect: PgConnect): { readonly options: Readonly<Record<string, never>>; connect(): Promise<PgClient & { release(): void }>; end(): Promise<void> } {
  return {
    // Kysely 0.29 requires pool options; this shim owns no connection configuration or control client.
    options: {},
    async connect() {
      const client = await connect();
      return Object.assign(client, { release: () => void client.end().catch(() => undefined) });
    },
    async end() {},
  };
}
