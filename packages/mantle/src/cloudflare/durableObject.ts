/**
 * `@aotter/mantle/cloudflare`, experimental: a SQLite-backed Durable Object's own storage as a `DatabaseDriver` (#1395,
 * ADR-0032 decision 6). Structural types, so this needs no `@cloudflare/workers-types`. Type-only imports on purpose:
 * a Worker bundle that imports this file must not pull in the SQL parser or printer (`durableObjectStorage` lives in `index.ts`).
 */
import type { DatabaseDriver, SqlStatement } from "../core/driver.js";

/** The parts of `DurableObjectStorage` (SQLite backend) the driver uses. */
export interface DurableObjectSqliteStorage {
  readonly sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[]; next(): { done?: boolean; value?: Record<string, unknown> } } };
  transactionSync<T>(closure: () => T): T;
}

/** DO SQL takes ArrayBuffer | string | number | null: a boolean is 0/1 (SQLite has no boolean), a missing value is NULL. `?N` binds are native. */
const value = (v: unknown) => (typeof v === "boolean" ? Number(v) : v ?? null);

/**
 * @experimental One `transactionSync` per batch (all or nothing, in-process and synchronous). `all` and `first` use the native
 * cursor outside a transaction, deliberately: no added round trips (ADR-0040 §2). `first` reads one row with `next()`; the DO
 * invalidates the unread cursor on its next `exec`, which is harmless. The engine's error is rethrown unchanged. Never call
 * Mantle from inside your own `transactionSync`.
 */
export function durableObjectDriver(storage: DurableObjectSqliteStorage): DatabaseDriver {
  const exec = (s: SqlStatement) => storage.sql.exec(s.sql, ...(s.binds ?? []).map(value));
  return {
    async batch(statements) { return storage.transactionSync(() => statements.map((s) => ({ rows: exec(s).toArray() }))); },
    async all(s) { return exec(s).toArray(); },
    async first(s) { const r = exec(s).next(); return r.done ? null : (r.value ?? null); },
  };
}
