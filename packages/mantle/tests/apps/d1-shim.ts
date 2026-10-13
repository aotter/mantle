/** The slice of D1 the kernel driver and the Better Auth adapter use, over bun:sqlite. Batches run synchronously in one native SQLite transaction, including row assertion rollback. */
import type { Database } from "bun:sqlite";

export function d1Shim(sqlite: Database) {
  const statement = (text: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(text, next),
    execute: () => ({ results: sqlite.query(text).all(...(values as never[])) as Record<string, unknown>[], meta: { changes: (sqlite.query("SELECT changes() AS c").get() as { c: number }).c } }),
    all: async () => statement(text, values).execute(),
  });
  return { prepare: (text: string) => statement(text), batch: async (statements: { execute(): { results: unknown[] } }[]) => sqlite.transaction(() => statements.map(s => s.execute()))() };
}
