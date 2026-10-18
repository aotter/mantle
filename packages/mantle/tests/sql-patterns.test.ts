import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { verifyOnLocalD1 } from "./apps/local-d1.js";
import { seed, verifySqlPatterns } from "./sql-patterns-scenarios.js";

const base = resolve(import.meta.dir, ".."), port = process.env.MANTLE_NEXT_SQL_PATTERNS_D1_PORT ?? "8990";
const composition = `import {userCaller} from '${resolve(base, "src/kernel/user-caller.ts")}';import {rest} from './rest.js';import {mcp} from './mcp.js';
const options={db:(env:{DB:any})=>env.DB,caller:async(request:Request)=>userCaller({id:"u",role:request.headers.get("x-role")},{adminRoles:["admin"],credential:"api-key",scopes:["mcp"]}),handlers:{}};
const api=rest(options),tools=mcp(options);
export const app=(request:Request,env:{DB:any})=>(new URL(request.url).pathname.startsWith("/mcp")?tools:api)(request,env);`;
// The guide's Views are admin-surface; public here so the oracle reads them through REST (requires stays ctx.admin).
const restViews = (text: string) => text.replaceAll("surface: admin", "surface: public");
// PostgreSQL's spelling of the nested read: jsonb_agg of zero rows is NULL, so default it to [].
const postgres = (text: string) => text.replace("json_group_array(json_set('{}', '$.id', o.id, '$.qty', o.qty))", "COALESCE(jsonb_agg(jsonb_build_object('id', o.id, 'qty', o.qty)), CAST('[]' AS jsonb))");

async function fixture(target: "bun-sqlite" | "bun-postgres" | "cloudflare-d1") {
  const sources = (await loadFixtureSources("sql-patterns.yaml")).map(source => ({ ...source, text: (target === "bun-postgres" ? postgres : (t: string) => t)(restViews(source.text)) }));
  const files = await generateOrThrow(target, sources), dir = await mkdtemp(join(base, "tests/apps/.sql-patterns-"));
  await writeGenerated(dir, files);
  await writeFile(join(dir, "app.ts"), composition);
  return { dir, files };
}

test("the nested JSON column is typed json at the boundary on every target: converted from SQLite text, native on PostgreSQL", async () => {
  for (const target of ["bun-sqlite", "cloudflare-d1", "bun-postgres"] as const) {
    const sources = (await loadFixtureSources("sql-patterns.yaml")).map(source => ({ ...source, text: (target === "bun-postgres" ? postgres : (t: string) => t)(restViews(source.text)) }));
    const files = await generateOrThrow(target, sources), sqlite = target !== "bun-postgres";
    expect(files["generated.ts"]).toContain(`Row = { readonly "id": unknown; readonly "name": string | null; readonly "orders": ${sqlite ? "string | null" : "unknown"}; };`);
    expect(files["generated.ts"]).toContain('readonly "name": string | null; readonly "orders": unknown; };');
    expect(files["rest.ts"]!.includes('["orders","json"]')).toBe(sqlite);
    expect(files["mcp.ts"]!.includes('["orders","json"]')).toBe(sqlite);
  }
});

test("bun:sqlite: the SQL patterns guide behaves as documented", async () => {
  const { dir, files } = await fixture("bun-sqlite");
  try {
    const db = new Database(":memory:");
    db.exec(files["schema.sql"]! + seed(false));
    const { app } = await import(join(dir, "app.ts"));
    await verifySqlPatterns(request => app(request, { DB: db }), async sql => db.query(sql).all() as Record<string, unknown>[], false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

(process.env.MANTLE_NEXT_BUN_PG_URL ? test : test.skip)("PostgreSQL: the SQL patterns guide behaves as documented", async () => {
  const { dir, files } = await fixture("bun-postgres"), sql = new SQL(process.env.MANTLE_NEXT_BUN_PG_URL!, { max: 1 }), schema = "patterns_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`); await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(files["schema.sql"]!); await sql.unsafe(seed(true));
    const { app } = await import(join(dir, "app.ts"));
    await verifySqlPatterns(request => app(request, { DB: sql }), async text => [...await sql.unsafe(text)], true);
  } finally { await rm(dir, { recursive: true, force: true }); await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await sql.close(); }
}, 30000);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("local D1: the SQL patterns guide behaves as documented", async () => {
  const { unstable_splitSqlQuery } = await import("wrangler"), { dir, files } = await fixture("cloudflare-d1");
  try {
    expect(await verifyOnLocalD1(dir, `${composition}\nimport {verifySqlPatterns} from ${JSON.stringify(resolve(import.meta.dir, "sql-patterns-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]! + seed(false)))})await env.DB.prepare(sql).run();
await verifySqlPatterns(request=>app(request,env),async sql=>(await env.DB.prepare(sql).all()).results,false);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`, port)).toEqual({ ok: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90000);

test("the guide's manifests are this test's fixture, minus its REST Triggers", async () => {
  const strip = (text: string) => text.split(/\n---\n/).map(doc => doc.replace(/^(#.*\n)+/, "").trim()).filter(doc => !/kind: Trigger/.test(doc));
  const guide = await readFile(resolve(base, "../../docs/handbook/guides/sql-patterns.md"), "utf8");
  const blocks = [...guide.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].flatMap(match => strip(match[1]!));
  expect(blocks).toEqual(strip(await readFile(resolve(import.meta.dir, "apps/sql-patterns.yaml"), "utf8")));
});
