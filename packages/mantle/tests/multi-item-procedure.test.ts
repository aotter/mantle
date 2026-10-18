import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";
import { seed, verifyMultiItem } from "./multi-item-scenarios.js";

const base = resolve(import.meta.dir, ".."), port = process.env.MANTLE_NEXT_ORDERS_D1_PORT ?? "8991";
const composition = `import {userCaller} from '${resolve(base, "src/kernel/user-caller.ts")}';import {rest} from './rest.js';
export const app=rest({db:(env:{DB:any})=>env.DB,caller:async()=>userCaller({id:"u",role:"user"},{adminRoles:["admin"],credential:"api-key"}),handlers:{}});`;
// PostgreSQL's row source over jsonb is jsonb_array_elements; its ->> is text, so lines cast to the column type.
const postgres = (text: string) => text.replaceAll("json_each(input.items) j", "jsonb_array_elements(input.items) AS j(value)")
  .replace("SUM(j.value ->> 'qty')", "SUM(CAST(j.value ->> 'qty' AS int8))").replace(", j.value ->> 'qty' FROM", ", CAST(j.value ->> 'qty' AS int8) FROM");

async function fixture(target: "bun-sqlite" | "bun-postgres" | "cloudflare-d1") {
  const sources = (await loadFixtureSources("orders.yaml")).map(source => target === "bun-postgres" ? { ...source, text: postgres(source.text) } : source);
  const files = await generateOrThrow(target, sources), dir = await mkdtemp(join(base, "tests/apps/.multi-item-"));
  await writeGenerated(dir, files);
  await writeFile(join(dir, "app.ts"), composition);
  return { dir, files };
}

test("bun:sqlite: a multi-line order commits every line or none", async () => {
  const { dir, files } = await fixture("bun-sqlite");
  try {
    const db = new Database(":memory:");
    db.exec(files["schema.sql"]! + seed(false));
    const { app } = await import(join(dir, "app.ts"));
    await verifyMultiItem(request => app(request, { DB: db }), async sql => db.query(sql).all() as Record<string, unknown>[]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: a multi-line order commits every line or none", async () => {
  const { dir, files } = await fixture("bun-postgres"), sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "orders_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`); await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(files["schema.sql"]!); await sql.unsafe(seed(true));
    const { app } = await import(join(dir, "app.ts"));
    await verifyMultiItem(request => app(request, { DB: sql }), async text => [...await sql.unsafe(text)], "_mantle_chk_products_0");
  } finally { await rm(dir, { recursive: true, force: true }); await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await sql.close(); }
}, 30000);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("local D1: a multi-line order commits every line or none", async () => {
  const { unstable_splitSqlQuery } = await import("wrangler"), { dir, files } = await fixture("cloudflare-d1");
  try {
    expect(await verifyOnLocalD1(dir, `${composition}\nimport {verifyMultiItem} from ${JSON.stringify(resolve(import.meta.dir, "multi-item-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]! + seed(false)))})await env.DB.prepare(sql).run();
await verifyMultiItem(request=>app(request,env),async sql=>(await env.DB.prepare(sql).all()).results);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`, port)).toEqual({ ok: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90000);
