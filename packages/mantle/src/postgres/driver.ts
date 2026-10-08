/**
 * The PostgreSQL connection port. Structural types of node-postgres (`pg`), so Mantle depends on no driver: the host passes
 * `connect`, which opens one client (`new Client(env.HYPERDRIVE.connectionString)` on Workers, where Hyperdrive pools the
 * connections and a socket must not outlive its request). Every operation opens a client and ends it; `requestScoped`
 * (session.ts) makes that one client per request.
 *
 * A transaction only where atomicity needs one (#1379): a read is one bare statement, one round trip. A write batch is
 * BEGIN … COMMIT; a client that pipelines (node-postgres `new Client({ pipeline: true })`) gets all of it written before the
 * first answer is read, one round trip, and one that does not takes N + 2. Nothing depends on per-transaction session state:
 * what decoding needs is the role's or the database's configuration, checked once at boot (`sessionProblems`).
 */
import type { DatabaseDriver, SqlResult, SqlStatement } from "../core/driver.js";
import { decodeField } from "./codec.js";

export interface PgField { readonly name: string; readonly dataTypeID: number; readonly dataTypeModifier?: number }
export interface PgResult { readonly rows: Record<string, unknown>[]; readonly rowCount: number | null; readonly fields: readonly PgField[] }
export interface PgClient {
  /** node-postgres pipeline mode: queries issued without awaiting share the wire. */
  readonly pipeline?: boolean;
  execute?(statement: PgStatement): Promise<PgOutcome>;
  query(config: { text: string; values?: unknown[]; types?: { getTypeParser(oid: number, format?: string): (text: string) => unknown } }): Promise<PgResult>;
  /** The positional form Kysely (Better Auth) calls. */
  query(text: string, values?: readonly unknown[]): Promise<PgResult & { command: string }>;
  end(): Promise<void>;
  /** node-postgres: the last ReadyForQuery's state, `I` idle, `T` in a transaction, `E` in a failed one. */
  getTransactionStatus?(): string | null;
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
/** ADR-0037 decision 5: a statement that runs away (a recursive CTE, a regular expression) ends here. 0 is no limit. */
export const STATEMENT_TIMEOUT_MS = 10_000;
/**
 * A transaction's first message, still one round trip. A write's own limit is `SET LOCAL` (convergence lifts it to build
 * indexes); a read has the role's, which boot checked.
 */
const begin = (head: string, timeoutMs: number) => `${head}; SET LOCAL statement_timeout = ${Math.max(0, Math.floor(timeoutMs))}`;
const ATTEMPTS = 5;

/**
 * Statements in one SERIALIZABLE transaction, all or nothing. SERIALIZABLE keeps what SQLite's one writer gave every guard
 * (`WHERE NOT EXISTS`, a first sign-up becoming owner): a concurrent write that would break one fails with 40001 and the
 * whole batch is retried. A write's `expect` is checked inside its own statement (executor.ts), so nothing waits between them.
 */
export async function transaction(connect: PgConnect, statements: readonly PgStatement[], timeoutMs = STATEMENT_TIMEOUT_MS): Promise<PgOutcome[]> {
  for (let attempt = 1; ; attempt++) {
    // a retry waits a random while first: writers that failed together, retried at once, collide again (a pipelined batch,
    // one round trip long, does so every time) and run out of attempts
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * 2 ** attempt));
    const client = await connect();
    if (client.pipeline && statements.every((s) => (s.values ?? []).every(wire))) {
      try {
        return await pipelined(client, begin("BEGIN ISOLATION LEVEL SERIALIZABLE", timeoutMs), statements);
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
      await client.query({ text: begin("BEGIN ISOLATION LEVEL SERIALIZABLE", timeoutMs) });
      const out: PgOutcome[] = [];
      for (const [i, s] of statements.entries()) {
        failedAt = i;
        out.push(await run(client, s));
        failedAt = -1;
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
 * One read: one statement in autocommit, which is a transaction of its own, one round trip. It runs under the session's
 * settings and statement_timeout, which boot checked; a read sees the write before it because the Hyperdrive config has
 * caching disabled (the generated preset creates it so, since Better Auth's reads were never in a transaction either).
 */
export async function query(connect: PgConnect, s: PgStatement): Promise<PgOutcome> {
  const client = await connect();
  try { return await run(client, s); } finally { await client.end().catch(() => undefined); }
}

/**
 * What decoding and the statement limit need from the server, read once at boot in one statement: anything returned is a
 * problem with the fix an operator runs. Role or database configuration, never `SET` per transaction: Hyperdrive resets a
 * pooled session to exactly that configuration, and a bare read has no transaction to pin anything in.
 * - DateStyle ISO and IntervalStyle postgres: the text `decodeField` parses. extra_float_digits >= 1: shortest exact floats.
 * - standard_conforming_strings on: a backslash in a printed literal is a backslash, never an escape.
 * - statement_timeout: a read is bounded by the role's limit, so it must be set and at most Mantle's (0 asks for none).
 */
export async function sessionProblems(connect: PgConnect, timeoutMs = STATEMENT_TIMEOUT_MS): Promise<string[]> {
  const client = await connect();
  try {
    // the driver's own types, int4 and bool only
    const [r] = (await client.query({ text: `SELECT quote_ident(current_user) AS role, quote_ident(current_database()) AS db,
      current_setting('DateStyle') AS datestyle, current_setting('IntervalStyle') AS intervalstyle,
      current_setting('extra_float_digits')::int4 AS float_digits, current_setting('standard_conforming_strings') AS scs,
      (SELECT setting::int4 FROM pg_settings WHERE name = 'statement_timeout') AS timeout_ms` })).rows as Record<string, any>[];
    const fix = (name: string, value: string) => `ALTER ROLE ${r!.role} SET ${name} = '${value}' (or ALTER DATABASE ${r!.db} SET …); new connections read it`;
    const ms = Math.max(0, Math.floor(timeoutMs));
    return [
      ...(/^ISO\b/i.test(r!.datestyle) ? [] : [`DateStyle is '${r!.datestyle}'; Mantle reads dates as ISO text: ${fix("DateStyle", "ISO, YMD")}`]),
      ...(r!.intervalstyle === "postgres" ? [] : [`IntervalStyle is '${r!.intervalstyle}'; Mantle reads intervals as PostgreSQL text: ${fix("IntervalStyle", "postgres")}`]),
      ...(r!.float_digits >= 1 ? [] : [`extra_float_digits is ${r!.float_digits}, which rounds float8 values: ${fix("extra_float_digits", "1")}`]),
      ...(r!.scs === "on" ? [] : [`standard_conforming_strings is off: ${fix("standard_conforming_strings", "on")}`]),
      ...(!ms || (r!.timeout_ms > 0 && r!.timeout_ms <= ms) ? [] :
        [`statement_timeout is ${r!.timeout_ms ? `${r!.timeout_ms} ms` : "unset"}; a read runs outside a transaction under the role's limit, which must be at most ${ms} ms (statementTimeoutMs): ${fix("statement_timeout", `${ms}ms`)}`]),
    ];
  } finally { await client.end().catch(() => undefined); }
}

/**
 * A bind node-postgres encodes without throwing. One it throws on fails on the client after Parse: it sends Close and Sync, the
 * server never sees an error, and a pipelined COMMIT would commit the statements around it. Such a batch goes one at a time.
 */
const wire = (v: unknown) => v == null || ["string", "number", "boolean", "bigint"].includes(typeof v) || v instanceof Date || ArrayBuffer.isView(v);

/**
 * BEGIN, every statement and COMMIT written at once. Each is its own Sync, so a failure the server answers leaves the
 * transaction aborted: the statements after it fail with 25P02 and COMMIT answers ROLLBACK, which ends it, so no ROLLBACK
 * follows. The first failure is the one reported, with its statement. A failure without a SQLSTATE is the socket's, and COMMIT
 * was already written: whether it ran is unknown (`committing`), wherever the first rejection landed.
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
  throw Object.assign(e as object, { statement: failed >= 1 && failed <= statements.length ? failed - 1 : -1, committing: failed === statements.length + 1 || !sqlState(e) });
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
export function pgPool(connect: PgConnect): PgAuthPool {
  return {
    // Kysely 0.29 requires pool options; this shim owns no connection configuration or control client.
    options: {},
    async connect() {
      const client = await connect();
      return Object.assign(client, { release: () => void client.end().catch(() => undefined) });
    },
    async end() {},
  } as unknown as PgAuthPool;
}
/** Kysely's PostgresPool, structurally (no auth import here). Kysely also declares a cursor form of `query`, which Better Auth never calls and the driver does not offer. */
export interface PgAuthPool {
  readonly options: Readonly<Record<string, never>>;
  connect(): Promise<{ query(sql: string, parameters: readonly unknown[]): Promise<any>; query(cursor: unknown): any; release(): void }>;
  end(): Promise<void>;
}
