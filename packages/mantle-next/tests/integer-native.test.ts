import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { integerSeed, verifyIntegers } from "./integer-scenarios.js";

for (const target of ["bun-sqlite", "bun-postgres"] as const) (target === "bun-sqlite" || process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)(`${target} preserves exact declared integers with native sorting and one read per page`, async () => {
  const files = await generateOrThrow(target, await loadFixtureSources("integer-parity.yaml"));
  const dir = await mkdtemp(join(import.meta.dir, "apps/.integer-"));
  const sqlite = target === "bun-sqlite";
  const db = sqlite ? new Database(":memory:") : new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 });
  const schema = "integer_" + crypto.randomUUID().replaceAll("-", "");
  let calls = 0;
  try {
    await writeGenerated(dir, files);
    const app = await import(join(dir, "generated.ts"));
    const native = async (sql: string) => sqlite ? (db as Database).query(sql).all() as Record<string, any>[] : [...await (db as SQL).unsafe(sql)];
    if (sqlite) (db as Database).exec(files["schema.sql"]! + ";" + integerSeed(true));
    else { await native(`CREATE SCHEMA ${schema}`); await native(`SET search_path TO ${schema}`); await native(files["schema.sql"]!); await native(integerSeed(false)); }
    const tapped = sqlite ? { query: (sql: string) => { calls++; return (db as Database).query(sql); } } : { unsafe: (sql: string, values: any[]) => { calls++; return (db as SQL).unsafe(sql, values); } };
    const pages: Record<string, Function> = {};
    for (const name of ["integer-order", "integer-ordinal", "integer-cte", "integer-grouped"]) {
      const page = (await import(join(dir, `paged/views/${name}.ts`))).default;
      pages[name] = async (_db: unknown, ...args: any[]) => { const before = calls; const result = await page(tapped, ...args); expect(calls - before).toBe(1); return result; };
    }
    expect((await verifyIntegers(app, db, sqlite, native, pages)).checks).toBe(23);
  } finally {
    if (sqlite) (db as Database).close();
    else { await (db as SQL).unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await (db as SQL).close(); }
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
