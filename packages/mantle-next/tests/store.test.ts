/** The shared Store scenarios on bun:sqlite, a D1 shim over it, and both PostgreSQL clients (set MANTLE_NEXT_BUN_PG_URL). The four real hosts run them in scripts/verify-native.ts. */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import postgres from "postgres";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { Target } from "../src/domain/model.js";
import { d1Shim } from "./apps/d1-shim.js";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { postgresOracleSql } from "./apps/oracle.js";
import { storeEnv, verifyStore } from "./store-scenarios.js";

type Calls = { sql: string; values: unknown[] }[];
const directory = resolve(import.meta.dir, "apps/.generated", `store-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));
async function generated(target: Target) {
  const files = await generateOrThrow(target, await loadFixtureSources("purchase.yaml", "store-extra.yaml", "store-equivalence.yaml", "store-transactions.yaml"));
  await writeGenerated(resolve(directory, target), files);
  return { app: await import(resolve(directory, target, "generated.ts")), schema: files["schema.sql"]!, types: files["generated.ts"]! };
}
/** The Database logging every statement the Store runs through it (the D1 shim runs on it too, so one tap serves both). */
const tap = (db: Database, calls: Calls): Database => {
  const own = <T extends object>(target: T, key: string | symbol) => { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; };
  return new Proxy(db, {
    get: (target, key) => key !== "query" ? own(target, key) : (sql: string) => {
      const statement = target.query(sql);
      return new Proxy(statement, { get: (_, method) => method !== "all" && method !== "run" ? own(statement, method) : (...values: unknown[]) => { if (!sql.startsWith("SELECT changes()")) calls.push({ sql, values }); return (statement as any)[method](...values); } });
    },
  });
};
const rows = (db: Database) => async (sql: string, values: readonly unknown[] = []) => db.query(sql).all(...values as never[]) as Record<string, unknown>[];

describe("Store", () => {
  test("generated types: a geo field's two columns are in the row, the scope column is nowhere, and orderBy is NOT NULL and indexed", async () => {
    const { types } = await generated("bun-sqlite");
    const table = (name: string) => new RegExp(`${name}: \\{ row:.*?order: [^}]*\\}`).exec(types)![0];
    expect(table("catalog_items")).toContain("place_lat: number | null; place_lng: number | null");
    expect(table("catalog_items")).toContain('order: "id" | "name"');
    expect(table("session_notes")).not.toContain("owner:");
  });
  test("bun:sqlite", async () => {
    const { app, schema } = await generated("bun-sqlite");
    const db = new Database(":memory:"); db.exec(schema);
    expect((await verifyStore(storeEnv(app, db, true, rows(db), calls => tap(db, calls)))).checks).toBeGreaterThan(30);
  }, 60_000);
  test("cloudflare-d1 (bun:sqlite shim)", async () => {
    const { app, schema } = await generated("cloudflare-d1");
    const sqlite = new Database(":memory:"); sqlite.exec(schema);
    expect((await verifyStore(storeEnv(app, d1Shim(sqlite), true, rows(sqlite), calls => d1Shim(tap(sqlite, calls))))).checks).toBeGreaterThan(30);
  }, 60_000);
  const url = process.env.MANTLE_NEXT_BUN_PG_URL;
  // Both clients satisfy the Postgres shape as they are.
  const clients: [label: string, open: (schema?: string) => any, close: (client: any) => unknown][] = [
    ["postgres.js", (schema?: string) => postgres(url!, { max: schema ? 4 : 1, onnotice: () => {}, ...(schema && { connection: { search_path: schema } }) }), c => c.end()],
    ["Bun.SQL", (schema?: string) => new SQL({ url: url!, max: schema ? 4 : 1, ...(schema && { connection: { search_path: schema } }) }), c => c.close()],
  ];
  for (const [label, open, close] of clients) test.skipIf(!url)(`bun-postgres on ${label}`, async () => {
    const { app, schema } = await generated("bun-postgres");
    const name = `store_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = open(); await admin.unsafe(`CREATE SCHEMA "${name}"`, []);
    const sql = open(name);
    try {
      await sql.unsafe(schema, []);
      const spy = (calls: Calls) => ({ begin: sql.begin.bind(sql), unsafe: (text: string, values: unknown[]) => { calls.push({ sql: text, values }); return sql.unsafe(text, values); } });
      const native = async (text: string, values: readonly unknown[] = []) => [...await sql.unsafe(postgresOracleSql(text), values as never[])];
      expect((await verifyStore(storeEnv(app, sql, false, native, spy))).checks).toBeGreaterThan(30);
    } finally { await close(sql); await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`, []); await close(admin); }
  }, 120_000);
});
