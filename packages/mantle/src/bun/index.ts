/** @aotter/mantle/bun: host-owned Admin files and the bun:sqlite driver. PostgreSQL on Bun is node-postgres (ADR-0039). No platform enters Core. */
declare const Bun: { file(path: string): Blob & { exists(): Promise<boolean> } };
import { sqliteStorage } from '../d1/index.js';
import { resolve, sep } from 'node:path';

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
  query(sql: string): { all(...binds: any[]): Record<string, unknown>[]; get(...binds: any[]): Record<string, unknown> | null };
  transaction<T>(run: () => T): { immediate(): T };
  readonly inTransaction: boolean;
}
/** Native cached queries and synchronous write batches. Never share this handle across an async transaction. */
export function bunSqliteDriver(db: BunSqliteDatabase): import('../core/driver.js').DatabaseDriver {
  db.query('PRAGMA foreign_keys = ON').all();
  const ready = () => {
    if (db.inTransaction) throw new Error('bun:sqlite: this handle is already in a transaction; use a separate handle for asynchronous transactions');
  };
  return {
    async batch(statements) {
      ready();
      return db.transaction(() => statements.map((s) => ({ rows: db.query(s.sql).all(...(s.binds ?? [])) }))).immediate();
    },
    async all(statement) { ready(); return db.query(statement.sql).all(...(statement.binds ?? [])); },
    async first(statement) { ready(); return db.query(statement.sql).get(...(statement.binds ?? [])) ?? null; },
  };
}
export const bunSqliteStorage = (db: BunSqliteDatabase, options?: Parameters<typeof sqliteStorage>[1]) => sqliteStorage(bunSqliteDriver(db), options);
