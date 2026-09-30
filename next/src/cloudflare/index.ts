/** `@aotter/mantle/cloudflare`: the D1 driver. Structural types, so this needs no `@cloudflare/workers-types`. */
import type { DatabaseDriver } from "../core/driver.js";
import { sqliteStorage } from "../core/sql/adapter.js";

interface D1PreparedStatement { bind(...values: unknown[]): D1PreparedStatement }
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<{ results?: Record<string, unknown>[] }[]>;
}

export function d1Driver(db: D1Database): DatabaseDriver {
  return {
    async batch(statements) {
      const out = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.binds ?? []))));
      return out.map((r) => ({ rows: r.results ?? [] }));
    },
  };
}

/** D1 storage for `createMantle`: `storage: (env) => d1Storage(env.DB)`. */
export const d1Storage = (db: D1Database, options?: { timeZone?: string }) => sqliteStorage(d1Driver(db), { ...options, maxBindings: 100 });
