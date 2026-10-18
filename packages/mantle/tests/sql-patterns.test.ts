import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { seed, verifySqlPatterns } from "./sql-patterns-scenarios.js";

const base = resolve(import.meta.dir, ".."), port = process.env.MANTLE_NEXT_SQL_PATTERNS_D1_PORT ?? "8990";
const composition = `import {userCaller} from '${resolve(base, "src/kernel/user-caller.ts")}';import {rest} from './rest.js';
export const app=rest({db:(env:{DB:any})=>env.DB,caller:async(request:Request)=>userCaller({id:"u",role:request.headers.get("x-role")},{adminRoles:["admin"],credential:"api-key"}),handlers:{}});`;
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
  const { unstable_splitSqlQuery } = await import("wrangler"), { dir, files } = await fixture("cloudflare-d1"), state = await mkdtemp(join(tmpdir(), "mantle-sql-patterns-d1-"));
  let worker: ReturnType<typeof spawn> | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(join(dir, "worker.ts"), `${composition}\nimport {verifySqlPatterns} from ${JSON.stringify(resolve(import.meta.dir, "sql-patterns-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]! + seed(false)))})await env.DB.prepare(sql).run();
return Response.json(await verifySqlPatterns(request=>app(request,env),async sql=>(await env.DB.prepare(sql).all()).results,false));}catch(error){return Response.json({error:String(error)},{status:500});}}};`);
    const config = join(state, "wrangler.json");
    await writeFile(config, JSON.stringify({ name: "mantle-sql-patterns-local", main: join(dir, "worker.ts"), compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "mantle-sql-patterns-local", database_id: "00000000-0000-0000-0000-000000000002" }] }));
    log = await open(join(state, "wrangler.log"), "w");
    worker = spawn("node", [join(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--persist-to", join(state, "state")], { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      if (worker.exitCode !== null) throw Error(await readFile(join(state, "wrangler.log"), "utf8"));
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (!ready) await new Promise(done => setTimeout(done, 1000));
    }
    expect(ready).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/verify`, { signal: AbortSignal.timeout(30000) });
    expect(await response.json()).not.toHaveProperty("error");
  } finally {
    if (worker && worker.exitCode === null) { const ended = once(worker, "exit"); try { process.kill(-worker.pid!, "SIGTERM"); } catch {} await ended; }
    await log?.close(); await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
}, 90000);

test("the guide's manifests are this test's fixture, minus its REST Triggers", async () => {
  const strip = (text: string) => text.split(/\n---\n/).map(doc => doc.replace(/^(#.*\n)+/, "").trim()).filter(doc => !/kind: Trigger/.test(doc));
  const guide = await readFile(resolve(base, "../../docs/handbook/guides/sql-patterns.md"), "utf8");
  const blocks = [...guide.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].flatMap(match => strip(match[1]!));
  expect(blocks).toEqual(strip(await readFile(resolve(import.meta.dir, "apps/sql-patterns.yaml"), "utf8")));
});
