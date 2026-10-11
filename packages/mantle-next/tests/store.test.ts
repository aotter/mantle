/** The shared Store scenarios on bun:sqlite, a D1 shim over it, and Bun.SQL PostgreSQL (set MANTLE_NEXT_BUN_PG_URL). The four real hosts run them in scripts/verify-native.ts. */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";
import type { Target } from "../src/domain/model.js";
import type { Caller } from "../src/kernel/contracts.js";
import { link } from "./apps/link.js";
import { verifyStore, type StoreEnv } from "./store-scenarios.js";

const directory = resolve(import.meta.dir, "apps/.generated", `store-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));
async function generated(target: Target) {
  const sources = await Promise.all(["purchase.yaml", "store-extra.yaml"].map(async name => ({ sourceId: name, text: await readFile(resolve(import.meta.dir, "apps", name), "utf8") })));
  const result = await generateFromSources({ target, sources: { sources } });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  for (const [name, text] of Object.entries(result.files)) {
    const file = resolve(directory, target, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, name.endsWith(".ts") ? link(text, "../../../../../src/kernel/") : text);
  }
  return { app: await import(resolve(directory, target, "generated.ts")), schema: result.files["schema.sql"]! };
}
const oracle = (sqlite: boolean) => (sql: string) => { if (sqlite) return sql; let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

/** The slice of D1 the driver uses, over bun:sqlite. Its batch is not atomic; the real local D1 run covers that. */
function d1Shim(sqlite: Database) {
  const statement = (text: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(text, next),
    all: async () => ({ results: sqlite.query(text).all(...(values as never[])) as Record<string, unknown>[], meta: { changes: (sqlite.query("SELECT changes() AS c").get() as { c: number }).c } }),
  });
  return { prepare: (text: string) => statement(text), batch: async (statements: { all(): Promise<{ results: unknown[] }> }[]) => { const out = []; for (const s of statements) out.push(await s.all()); return out; } };
}

function env(sqlite: boolean, app: any, db: any, native: StoreEnv["native"], recorder: (calls: { sql: string; values: unknown[] }[]) => unknown): StoreEnv {
  return {
    sqlite, native,
    stores: (caller: Caller) => ({ purchase_requests: app.stores.purchase_requests(db, caller), session_notes: app.stores.session_notes(db, caller), catalog_items: app.stores.catalog_items(db, caller) }),
    call: (name, caller, input) => app.procedures[name](db, caller, input),
    record: async (caller, run) => {
      const calls: { sql: string; values: unknown[] }[] = [];
      const spy = recorder(calls);
      await run({ purchase_requests: app.stores.purchase_requests(spy, caller), session_notes: app.stores.session_notes(spy, caller), catalog_items: app.stores.catalog_items(spy, caller) });
      return calls.at(-1)!;
    },
  };
}

describe("Store", () => {
  test("bun:sqlite", async () => {
    const { app, schema } = await generated("bun-sqlite");
    const db = new Database(":memory:"); db.exec(schema);
    const recorder = (calls: { sql: string; values: unknown[] }[]) => ({ query: (sql: string) => { const s = db.query(sql); return { columnNames: s.columnNames, all: (...values: unknown[]) => { calls.push({ sql, values }); return s.all(...values as never[]); }, run: (...values: unknown[]) => { calls.push({ sql, values }); return s.run(...values as never[]); } }; }, transaction: (fn: never) => db.transaction(fn) });
    const report = await verifyStore(env(true, app, db, async (sql, values = []) => db.query(sql).all(...values as never[]) as Record<string, unknown>[], recorder));
    expect(report.checks).toBeGreaterThan(30);
  }, 60_000);
  test("cloudflare-d1 (bun:sqlite shim)", async () => {
    const { app, schema } = await generated("cloudflare-d1");
    const sqlite = new Database(":memory:"); sqlite.exec(schema);
    const db = d1Shim(sqlite);
    const recorder = (calls: { sql: string; values: unknown[] }[]) => ({ prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ all: () => { calls.push({ sql, values }); return db.prepare(sql).bind(...values).all(); } }) }), batch: db.batch });
    const report = await verifyStore(env(true, app, db, async (sql, values = []) => sqlite.query(sql).all(...values as never[]) as Record<string, unknown>[], recorder));
    expect(report.checks).toBeGreaterThan(30);
  }, 60_000);
  const url = process.env.MANTLE_NEXT_BUN_PG_URL;
  test.skipIf(!url)("bun-postgres (Bun.SQL)", async () => {
    const { app, schema } = await generated("bun-postgres");
    const name = `store_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new SQL(url!); await admin.unsafe(`CREATE SCHEMA "${name}"`, []);
    const sql = new SQL({ url: url!, connection: { search_path: name }, max: 4 });
    try {
      await sql.unsafe(schema);
      const toPg = oracle(false);
      const recorder = (calls: { sql: string; values: unknown[] }[]) => ({ begin: sql.begin.bind(sql), unsafe: (text: string, values: unknown[]) => { calls.push({ sql: text, values }); return sql.unsafe(text, values as never[]); } });
      const report = await verifyStore(env(false, app, sql, async (text, values = []) => [...await sql.unsafe(toPg(text), values as never[])], recorder));
      expect(report.checks).toBeGreaterThan(30);
    } finally { await sql.close(); await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`, []); await admin.close(); }
  }, 120_000);
});
