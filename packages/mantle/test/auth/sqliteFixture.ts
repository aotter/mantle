import { DatabaseSync } from "node:sqlite";
import type { DatabaseDriver } from "../../src/core/index.js";
import type { CreateMantleAuthOptions } from "../../src/auth/index.js";

/**
 * Better Auth and Mantle over one real SQLite database, as a Worker has them over one D1: Better Auth gets the D1 shape the
 * preset hands it (Node 22.14's `node:sqlite` lacks what Better Auth's own node dialect needs).
 */
export function sqlite(rejectVerificationDelete: () => boolean = () => false) {
  const db = new DatabaseSync(":memory:");
  const exec = (sql: string, binds: readonly unknown[] = []) => {
    if (rejectVerificationDelete() && /^\s*DELETE\b.*\bverification\b/i.test(sql)) throw new Error("injected OTP cleanup failure");
    // Node 22's `node:sqlite` binds only anonymous `?`, so a numbered `?N` becomes `?` with its value in order
    const ordered: unknown[] = [];
    const text = sql.replace(/\?(\d+)/g, (_, n: string) => (ordered.push(binds[Number(n) - 1]), "?"));
    const values = (ordered.length ? ordered : binds).map((b) => (typeof b === "boolean" ? Number(b) : b)) as never[];
    const rows = db.prepare(text).all(...values) as Record<string, unknown>[];
    const { c, r } = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
    return { rows, changes: c, lastRowId: r };
  };
  const statement = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => statement(sql, b),
    all: async () => { const { rows, changes, lastRowId } = exec(sql, binds); return { results: rows, success: true, meta: { changes, last_row_id: lastRowId } }; },
  });
  const tx = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try { const out = run(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const d1 = {
    prepare: (sql: string) => statement(sql),
    exec: async (sql: string) => (db.exec(sql), { count: 0, duration: 0 }),
    batch: async (stmts: ReturnType<typeof statement>[]) => Promise.all(stmts.map((s) => s.all())),
  };
  const driver: DatabaseDriver = { batch: async (stmts) => tx(() => stmts.map((s) => exec(s.sql, s.binds))) };
  return { d1: d1 as unknown as CreateMantleAuthOptions["database"], driver };
}

