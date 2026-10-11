/** The slice of D1 the kernel driver and the Better Auth adapter use, over bun:sqlite. D1 runs SQLite with foreign keys enforced; its batch here is not atomic (the real local D1 run in verify-native covers that). */
import type { Database } from "bun:sqlite";

export function d1Shim(sqlite: Database) {
  const statement = (text: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(text, next),
    all: async () => ({ results: sqlite.query(text).all(...(values as never[])) as Record<string, unknown>[], meta: { changes: (sqlite.query("SELECT changes() AS c").get() as { c: number }).c } }),
  });
  return { prepare: (text: string) => statement(text), batch: async (statements: { all(): Promise<{ results: unknown[] }> }[]) => { const out = []; for (const s of statements) out.push(await s.all()); return out; } };
}
