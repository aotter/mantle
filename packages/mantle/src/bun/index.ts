/** @aotter/mantle/bun: native PostgreSQL pool and host-owned Admin files. No platform enters Core. */
import { postgresStorage, type PostgresStorageOptions, pgDatabaseDriver, pgPool } from '../postgres/index.js';
/** Structural Bun.SQL types keep its global fetch declarations out of portable SDK consumers. */
interface NativeResult extends Array<any> { count?: number; command?: string }
interface NativeQuery extends Promise<NativeResult> { raw(): NativeQuery; simple(): NativeQuery }
interface NativeConnection { unsafe(text: string, values?: unknown[]): NativeQuery; release(): void; close(): Promise<void> }
export interface BunSqlPool { readonly options: { readonly prepare?: boolean; readonly adapter?: string }; reserve(): Promise<NativeConnection> }
declare const Bun: { file(path: string): Blob & { exists(): Promise<boolean> } };
import type { PgClient, PgConnect, PgResult, PgStatement } from '../postgres/driver.js';
import { decodeField } from '../postgres/codec.js';
import { sqliteStorage } from '../d1/index.js';
import { resolve, sep } from 'node:path';

/** Reserve one pool connection per operation; end releases it after COMMIT/ROLLBACK, never closes the shared pool. */
export function bunPgConnect(sql: BunSqlPool): PgConnect {
  if (sql.options.adapter !== 'postgres' || sql.options.prepare !== false) throw new TypeError('Mantle requires Bun.SQL PostgreSQL with prepare: false to preserve encoded JSON binds');
  return async () => {
    const connection = await sql.reserve();
    let released = false;
    // a failed ROLLBACK leaves the session in a transaction: that connection is closed, never handed to the next operation
    let dirty = false;
    const run = async (text: string, values: readonly unknown[] = [], raw = false) => {
      try {
        const query = connection.unsafe(text, values.map((v) => v instanceof Date ? v.toISOString() : v));
        // BEGIN + pinned SET LOCALs are trusted, bind-free commands owned by the PostgreSQL driver.
        const result = raw ? query.raw() : query;
        return await (values.length ? result : result.simple());
      } catch (error) {
        const e = error as Error & { errno?: string; code?: string };
        if (typeof e.errno === 'string' && /^[0-9A-Z]{5}$/.test(e.errno)) e.code = e.errno;
        if (/^\s*ROLLBACK\b/i.test(text)) dirty = true;
        throw error;
      }
    };
    const query: PgClient['query'] = async (config: string | { text: string; values?: unknown[] }, values?: readonly unknown[]) => {
      const out = await run(typeof config === 'string' ? config : config.text, typeof config === 'string' ? values : config.values);
      return { rows: [...out], rowCount: out.count ?? 0, fields: [], command: out.command ?? '' } as PgResult & { command: string };
    };
    return {
      query,
      temporaryResultMetadata: true,
      async execute(s: PgStatement) {
        const described = s.describeResult?.();
        // Auth's DatabaseDriver also issues trusted SELECTs. Its native Kysely pool keeps ordinary Bun values.
        // the trusted driver's reads are described too; a WITH that writes is run as it is (CTAS cannot wrap a top-level write)
        const head = s.text.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
        const reads = /^\(*\s*(SELECT|VALUES|TABLE)\b/i.test(head) || (/^WITH\b/i.test(head) && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(head));
        const describe = described ?? (reads ? { query: s.text, names: undefined } : undefined);
        if (describe) {
          // ponytail: three metadata round trips per result. Remove when Bun exposes public RowDescription OIDs + typmods.
          // WITH NO DATA does not execute SELECT or DML; regression tests assert no duplicate writes.
          const table = `_mantle_result_${crypto.randomUUID().replace(/-/g, '')}`;
          const columnList = describe.names?.map((_n, i) => `"c${i}"`).join(',');
          await run(`CREATE TEMP TABLE "${table}"${columnList ? `(${columnList})` : ''} ON COMMIT DROP AS ${describe.query} WITH NO DATA`, s.values).catch((e: Error & { code?: string }) => {
            if (e.code === '42501') e.message = `${e.message}: the Bun PostgreSQL host describes results with CREATE TEMP TABLE, so its role needs GRANT TEMPORARY ON DATABASE (ADR-0038)`;
            throw e;
          });
          const fields = await run(`SELECT attname, atttypid::int4 AS oid, atttypmod AS mod FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [table]);
          await run(`DROP TABLE "${table}"`);
          // the describe had to begin read-write; a read runs read-only from here, as on every other PostgreSQL host
          if (s.readOnly) await run('SET TRANSACTION READ ONLY');
          const out = await run(s.text, s.values, true);
          return {
            rows: out.map((row: (Uint8Array | null)[]) => Object.fromEntries(fields.map((f: any, i: number) => [describe.names?.[i] ?? f.attname, decodeField(f.oid, row[i] === null ? null : new TextDecoder().decode(row[i]), f.mod)]))),
            count: out.count ?? out.length,
          };
        }
        if (s.readOnly) await run('SET TRANSACTION READ ONLY');
        const out = await run(s.text, s.values);
        return { rows: [...out], count: out.count ?? out.length };
      },
      async end() {
        if (released) return;
        released = true;
        if (dirty) await connection.close().catch(() => undefined);
        else connection.release();
      },
    };
  };
}

/** The dialect still owns policy, storage convergence and transactions. The host supplies a native pool. */
export const bunPostgresStorage = (sql: BunSqlPool, options: Omit<PostgresStorageOptions, 'connect'> = {}) => postgresStorage({ ...options, connect: bunPgConnect(sql) });
export const bunDatabaseDriver = (sql: BunSqlPool) => pgDatabaseDriver(bunPgConnect(sql));
/**
 * Better Auth's PostgreSQL `database`: Kysely's PostgresPool, structurally (no auth import here). Kysely also declares a cursor
 * form of `query`, which Better Auth never calls and the driver does not offer.
 */
export interface BunAuthPool {
  readonly options: Readonly<Record<string, never>>;
  connect(): Promise<{ query(sql: string, parameters: readonly unknown[]): Promise<any>; query(cursor: unknown): any; release(): void }>;
  end(): Promise<void>;
}
export const bunAuthDatabase = (sql: BunSqlPool): BunAuthPool => pgPool(bunPgConnect(sql)) as unknown as BunAuthPool;

/** Serve the installed Admin bundle. Reject traversal and symlinks outside the supplied root. */
export function bunAdminAssets(root: string): (path: string) => Promise<Response | null> {
  const base = resolve(root);
  return async (path) => {
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return null; }
    if (/[\u0000-\u001f]/.test(decoded)) return null;
    const target = resolve(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
    if (!target.startsWith(`${base}${sep}`)) return null;
    const file = Bun.file(target);
    if (!(await file.exists())) return null;
    const { realpath } = await import('node:fs/promises');
    const physical = await realpath(target).catch(() => '');
    if (!physical.startsWith(`${await realpath(base)}${sep}`)) return null;
    return new Response(file);
  };
}

/** Structural bun:sqlite database. One native synchronous transaction per batch. */
export interface BunSqliteDatabase {
  prepare(sql: string): { all(...binds: any[]): Record<string, unknown>[] };
  transaction<T>(run: () => T): { immediate(): T };
  readonly inTransaction: boolean;
}
/**
 * One native synchronous transaction per batch. Foreign keys are on, as on D1 (Better Auth's tables cascade). Better Auth holds
 * its own transactions open across awaits on the same handle: a batch waits for one to end, or it would become a savepoint
 * inside it and an acknowledged write could roll back with it. A batch itself never yields, so nothing interleaves with it.
 */
export function bunSqliteDriver(db: BunSqliteDatabase): import('../core/driver.js').DatabaseDriver {
  db.prepare('PRAGMA foreign_keys = ON').all();
  return {
    async batch(statements) {
      for (const deadline = Date.now() + 5_000; db.inTransaction; await new Promise((r) => setTimeout(r, 1)))
        if (Date.now() > deadline) throw new Error('bun:sqlite: a transaction on this handle stayed open for 5 s');
      return db.transaction(() => statements.map((s) => ({ rows: db.prepare(s.sql).all(...(s.binds ?? [])) }))).immediate();
    },
  };
}
export const bunSqliteStorage = (db: BunSqliteDatabase, options?: Parameters<typeof sqliteStorage>[1]) => sqliteStorage(bunSqliteDriver(db), options);
