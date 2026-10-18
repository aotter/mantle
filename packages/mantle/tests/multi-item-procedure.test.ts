import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { seed, verifyMultiItem } from "./multi-item-scenarios.js";

const base = resolve(import.meta.dir, "..");
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
    await verifyMultiItem(request => app(request, { DB: sql }), async text => [...await sql.unsafe(text)]);
  } finally { await rm(dir, { recursive: true, force: true }); await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await sql.close(); }
}, 30000);

(process.env.MANTLE_NEXT_REST_D1 ? test : test.skip)("local D1: a multi-line order commits every line or none", async () => {
  const { unstable_splitSqlQuery } = await import("wrangler"), { dir, files } = await fixture("cloudflare-d1"), state = await mkdtemp(join(tmpdir(), "mantle-orders-d1-"));
  let worker: ReturnType<typeof spawn> | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(join(dir, "worker.ts"), `${composition}\nimport {verifyMultiItem} from ${JSON.stringify(resolve(import.meta.dir, "multi-item-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]! + seed(false)))})await env.DB.prepare(sql).run();
await verifyMultiItem(request=>app(request,env),async sql=>(await env.DB.prepare(sql).all()).results);return Response.json({ok:true});}catch(error){return Response.json({error:String(error)},{status:500});}}};`);
    const config = join(state, "wrangler.json");
    await writeFile(config, JSON.stringify({ name: "mantle-orders-local", main: join(dir, "worker.ts"), compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "mantle-orders-local", database_id: "00000000-0000-0000-0000-000000000001" }] }));
    log = await open(join(state, "wrangler.log"), "w");
    worker = spawn("node", [join(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", "8994", "--inspector-port", "0", "--persist-to", join(state, "state")], { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      if (worker.exitCode !== null) throw Error(await readFile(join(state, "wrangler.log"), "utf8"));
      try { ready = (await fetch("http://127.0.0.1:8994/health", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (!ready) await new Promise(done => setTimeout(done, 1000));
    }
    expect(ready).toBe(true);
    const response = await fetch("http://127.0.0.1:8994/verify", { signal: AbortSignal.timeout(30000) });
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    if (worker && worker.exitCode === null) { const ended = once(worker, "exit"); try { process.kill(-worker.pid!, "SIGTERM"); } catch {} await ended; }
    await log?.close(); await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
}, 90000);
