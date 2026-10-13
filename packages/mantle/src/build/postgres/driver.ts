/** Native node-postgres execution: one acquired client per operation, released to its application-owned Pool or ended.
 * Writes use one native SERIALIZABLE transaction. Serialization/deadlock failures surface without automatic retry.
 */
import type { DatabaseDriver, SqlResult, SqlStatement } from "../core/driver.js";
import { decodeField } from "./codec.js";

export interface PgField { readonly name: string; readonly dataTypeID: number; readonly dataTypeModifier?: number }
export interface PgResult { readonly rows: Record<string, unknown>[]; readonly rowCount: number | null; readonly fields: readonly PgField[] }
export interface PgClient {
  query(config: { text: string; values?: unknown[]; types?: { getTypeParser(oid: number, format?: string): (text: string) => unknown } }): Promise<PgResult>;
  /** The positional form Kysely (Better Auth) calls. */
  query(text: string, values?: readonly unknown[]): Promise<PgResult & { command: string }>;
  end(): Promise<void>;
  /** Present on the official PoolClient; never replace its native release. */
  release?(error?: Error | boolean): void;
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
  const r = await client.query({ text: s.text, values: [...(s.values ?? [])], types: RAW });
  const rows = r.rows.map((row) => Object.fromEntries(r.fields.map((f) => [f.name, decodeField(f.dataTypeID, row[f.name] as string | null, f.dataTypeModifier)])));
  return { rows, count: r.rowCount ?? rows.length };
}

/** ADR-0037 decision 5: a statement that runs away (a recursive CTE, a regular expression) ends here. 0 is no limit. */
export const STATEMENT_TIMEOUT_MS = 10_000;
/**
 * A transaction's first message, still one round trip. A write's own limit is `SET LOCAL` (convergence lifts it to build
 * indexes); a read has the role's, which boot checked.
 */
const begin = (head: string, timeoutMs: number) => `${head}; SET LOCAL statement_timeout = ${Math.max(0, Math.floor(timeoutMs))}`;
/** Return only healthy clients to a native Pool; standalone Clients always close. */
export async function releaseClient(client: PgClient, discard = false): Promise<void> {
  if (client.release) client.release(discard);
  else await client.end();
}

/** A single native SERIALIZABLE transaction; no SDK retry, pipeline or request-level sharing. */
export async function transaction(connect: PgConnect, statements: readonly PgStatement[], timeoutMs = STATEMENT_TIMEOUT_MS): Promise<PgOutcome[]> {
  const client = await connect();
  let failedAt = -1;
  let committing = false;
  let discard = false;
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
    discard = !sqlState(e) || /^08/.test(sqlState(e)!);
    await client.query({ text: "ROLLBACK" }).catch(() => { discard = true; });
    // A rollback reply cannot resolve an earlier unanswered COMMIT; never replay that write.
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { statement: failedAt, committing });
  } finally {
    await releaseClient(client, discard).catch(() => undefined);
  }
}

/**
 * One read: one statement in autocommit, which is a transaction of its own, one round trip. It runs under the session's
 * settings and statement_timeout, which boot checked; a read sees the write before it because the Hyperdrive config has
 * caching disabled (the generated preset creates it so, since Better Auth's reads were never in a transaction either).
 */
export async function query(connect: PgConnect, s: PgStatement): Promise<PgOutcome> {
  const client = await connect();
  let discard = false;
  try { return await run(client, s); }
  catch (e) { discard = !sqlState(e) || /^08/.test(sqlState(e)!); throw e; }
  finally { await releaseClient(client, discard).catch(() => undefined); }
}

/**
 * What decoding and the statement limit need from the server, and the converged fingerprint, read once at boot in one statement: anything returned is a
 * problem with the fix an operator runs. Role or database configuration, never `SET` per transaction: Hyperdrive resets a
 * pooled session to exactly that configuration, and a bare read has no transaction to pin anything in.
 * - DateStyle ISO and IntervalStyle postgres: the text `decodeField` parses. extra_float_digits >= 1: shortest exact floats.
 * - standard_conforming_strings on: a backslash in a printed literal is a backslash, never an escape.
 * - TimeZone UTC: not for decoding (`decodeField` reads any offset PostgreSQL prints) but for meaning, since a cast between date
 *   and timestamptz, explicit or implicit, is taken in the session's zone, and an author's SQL cannot be checked for those casts.
 * - statement_timeout: a read is bounded by the role's limit, so it must be set and at most Mantle's (0 asks for none).
 */
export async function bootRead(connect: PgConnect, timeoutMs = STATEMENT_TIMEOUT_MS): Promise<{ problems: string[]; booted: string | null }> {
  const client = await connect();
  try {
    // the driver's own types, int4 and bool only
    const settings = `SELECT quote_ident(current_user) AS role, quote_ident(current_database()) AS db,
      current_setting('DateStyle') AS datestyle, current_setting('IntervalStyle') AS intervalstyle,
      current_setting('extra_float_digits')::int4 AS float_digits, current_setting('standard_conforming_strings') AS scs,
      (SELECT setting::int4 FROM pg_settings WHERE name = 'statement_timeout') AS timeout_ms, current_setting('TimeZone') AS tz,
      (SELECT bool_and(extract(timezone FROM t) = 0) FROM unnest('{1900-01-01 00:00+00, 1970-01-01 00:00+00, 2000-01-01 00:00+00, 2000-07-01 00:00+00}'::timestamptz[]) t) AS utc`;
    // the converged state rides along in the same statement; a database never booted has no table, which fails the statement
    // (42P01) and costs the first boot one more round trip, once
    const booted = ", (SELECT value FROM _mantle_boot_state WHERE key = 'fingerprint') AS booted";
    const [r] = (await client.query({ text: settings + booted }).catch((e) => {
      if (sqlState(e) !== "42P01") throw e;
      return client.query({ text: settings });
    })).rows as Record<string, any>[];
    const fix = (name: string, value: string) => `ALTER ROLE ${r!.role} SET ${name} = '${value}' (or ALTER DATABASE ${r!.db} SET …); new connections read it`;
    const ms = Math.max(0, Math.floor(timeoutMs));
    const problems = [
      ...(/^ISO\b/i.test(r!.datestyle) ? [] : [`DateStyle is '${r!.datestyle}'; Mantle reads dates as ISO text: ${fix("DateStyle", "ISO, YMD")}`]),
      ...(r!.intervalstyle === "postgres" ? [] : [`IntervalStyle is '${r!.intervalstyle}'; Mantle reads intervals as PostgreSQL text: ${fix("IntervalStyle", "postgres")}`]),
      ...(r!.float_digits >= 1 ? [] : [`extra_float_digits is ${r!.float_digits}, which rounds float8 values: ${fix("extra_float_digits", "1")}`]),
      ...(r!.utc ? [] : [`TimeZone is '${r!.tz}'; Mantle casts between dates and instants in UTC: ${fix("TimeZone", "UTC")}`]),
      ...(r!.scs === "on" ? [] : [`standard_conforming_strings is off: ${fix("standard_conforming_strings", "on")}`]),
      ...(!ms || (r!.timeout_ms > 0 && r!.timeout_ms <= ms) ? [] :
        [`statement_timeout is ${r!.timeout_ms ? `${r!.timeout_ms} ms` : "unset"}; a read runs outside a transaction under the role's limit, which must be at most ${ms} ms (statementTimeoutMs): ${fix("statement_timeout", `${ms}ms`)}`]),
    ];
    return { problems, booted: typeof r!.booted === "string" ? r!.booted : null };
  } finally { await releaseClient(client).catch(() => undefined); }
}

/** `?1` binds (Mantle's portable SQL) as PostgreSQL's `$1`, outside quoted strings and names. */
export const numbered = (sql: string) => sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?(\d+)/g, (m, n?: string) => (n ? `$${n}` : m));

/**
 * The `DatabaseDriver` over PostgreSQL, for auth's portable SQL and the conformance fixtures: every batch is one transaction, a single read is not.
 */
export function pgDatabaseDriver(connect: PgConnect): DatabaseDriver {
  return {
    async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
      return (await transaction(connect, statements.map((s) => ({ text: numbered(s.sql), values: s.binds })))).map((o) => ({ rows: o.rows }));
    },
    // a read is one statement in autocommit (`query`): no BEGIN, no COMMIT, no isolation retry loop
    async all(s) { return (await query(connect, { text: numbered(s.sql), values: s.binds })).rows; },
    async first(s) { return (await query(connect, { text: numbered(s.sql), values: s.binds })).rows[0] ?? null; },
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
      if (client.release) return client;
      return { query: client.query.bind(client), release: () => void client.end().catch(() => undefined) };
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
