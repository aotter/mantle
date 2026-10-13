/** ADR-0046 spike: attribute binds and attribute scope on bun:sqlite, a D1 shim, Bun.SQL and postgres.js (set MANTLE_NEXT_BUN_PG_URL). */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import postgres from "postgres";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import type { Target } from "../src/domain/model.js";
import { d1Shim } from "./apps/d1-shim.js";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { verifyAttrs } from "./attrs-scenarios.js";

const directory = resolve(import.meta.dir, "apps/.generated", `attrs-${crypto.randomUUID()}`);
afterAll(() => rm(directory, { recursive: true, force: true }));
async function generated(target: Target) {
  const files = await generateOrThrow(target, await loadFixtureSources("attrs.yaml"));
  await writeGenerated(resolve(directory, target), files);
  return { app: await import(resolve(directory, target, "generated.ts")), schema: files["schema.sql"]! };
}

describe("caller attributes (ADR-0046)", () => {
  test("bun:sqlite", async () => {
    const { app, schema } = await generated("bun-sqlite");
    const db = new Database(":memory:"); db.exec(schema);
    expect(await verifyAttrs(app, db)).toBeGreaterThan(40);
  }, 60_000);
  test("bun:sqlite plans the attribute predicate as an index search, not a scan", async () => {
    const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("attrs.yaml"));
    const db = new Database(":memory:"); db.exec(files["schema.sql"]!);
    const sql = /const view3Caller = \{ sql: ("[^"]+")/.exec(files["generated.ts"]!)![1]!;
    const plan = db.query(`EXPLAIN QUERY PLAN ${JSON.parse(sql)}`).all('["TW"]').map((r: any) => r.detail).join(" | ");
    expect(JSON.parse(sql)).toContain("json_each");
    expect(plan).toMatch(/SEARCH orders USING INDEX \S+ \(region=\?\)/);
  });
  test("cloudflare-d1 (bun:sqlite shim)", async () => {
    const { app, schema } = await generated("cloudflare-d1");
    const sqlite = new Database(":memory:"); sqlite.exec(schema);
    expect(await verifyAttrs(app, d1Shim(sqlite))).toBeGreaterThan(40);
  }, 60_000);
  const url = process.env.MANTLE_NEXT_BUN_PG_URL;
  const clients: [label: string, open: (schema?: string) => any, close: (client: any) => unknown][] = [
    ["postgres.js", (schema?: string) => postgres(url!, { max: schema ? 4 : 1, onnotice: () => {}, ...(schema && { connection: { search_path: schema } }) }), c => c.end()],
    ["Bun.SQL", (schema?: string) => new SQL({ url: url!, max: schema ? 4 : 1, ...(schema && { connection: { search_path: schema } }) }), c => c.close()],
  ];
  for (const [label, open, close] of clients) test.skipIf(!url)(`bun-postgres on ${label}`, async () => {
    const { app, schema } = await generated("bun-postgres");
    const name = `attrs_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = open(); await admin.unsafe(`CREATE SCHEMA "${name}"`, []);
    const sql = open(name);
    try {
      await sql.unsafe(schema, []);
      expect(await verifyAttrs(app, sql)).toBeGreaterThan(40);
    } finally { await close(sql); await admin.unsafe(`DROP SCHEMA "${name}" CASCADE`, []); await close(admin); }
  }, 120_000);
});
