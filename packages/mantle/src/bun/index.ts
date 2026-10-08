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
