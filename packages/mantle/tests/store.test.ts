/** The shared Store scenarios on bun:sqlite, a D1 shim over it, and both PostgreSQL clients (set MANTLE_NEXT_BUN_PG_URL). The four real hosts run them in scripts/verify-native.ts. */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { Target } from "../src/domain/model.js";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
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

});
