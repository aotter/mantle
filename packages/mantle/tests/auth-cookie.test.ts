import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { d1Adapter, postgresAdapter } from "../src/auth/adapter.js";
import { d1Shim } from "./apps/d1-shim.js";
import { verifyCookieCaller } from "./auth-cookie-scenarios.js";

test("real Better Auth cookie reads, refresh, revocation and field mapping on SQLite", async () => {
  const db = new Database(":memory:"), statements: string[] = [], native = d1Shim(db);
  db.exec("PRAGMA foreign_keys=ON");
  try {
    const counts = await verifyCookieCaller(d1Adapter({ prepare: text => { statements.push(text); return native.prepare(text); } }), "sqlite", async (text, values = []) => db.query(text).all(...values as never[]) as Record<string, unknown>[], statements);
    expect(counts["native:fresh"]).toBe(2); expect(counts["native:read-first"]).toBe(1); expect(counts["native:read-warm"]).toBe(1); expect(counts["secondary:refresh"]).toBe(2);
  } finally { db.close(); }
});

const url = process.env.MANTLE_NEXT_BUN_PG_URL;
(url ? test : test.skip)("real Better Auth cookie reads and expiry on PostgreSQL", async () => {
  const schema = `cookie_${crypto.randomUUID().replaceAll("-", "")}`, admin = new SQL(url!), statements: string[] = [];
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const sql = new SQL(url!, { connection: { search_path: schema }, max: 1 });
  try {
    const handle = { unsafe: (text: string, values: unknown[]) => { statements.push(text); return sql.unsafe(text, values); }, begin: sql.begin.bind(sql) };
    const counts = await verifyCookieCaller(postgresAdapter(handle as never), "postgres", async (text, values = []) => [...await sql.unsafe(text, values)], statements);
    expect(counts["native:fresh"]).toBe(2); expect(counts["renamed:refresh"]).toBe(2);
  } finally { await sql.close(); await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
}, 30000);

(process.env.MANTLE_NEXT_AUTH_D1 ? test : test.skip)("real Better Auth cookie oracle on actual local D1", async () => {
  const { mkdtemp, writeFile, open, readFile, rm } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process"), { once } = await import("node:events"), { join, resolve } = await import("node:path"), { tmpdir } = await import("node:os");
  const base = resolve(import.meta.dir, ".."), dir = await mkdtemp(join(base, "tests/apps/.auth-cookie-")), state = await mkdtemp(join(tmpdir(), "mantle-auth-cookie-"));
  const port = process.env.MANTLE_NEXT_AUTH_PORT ?? "8994";
  let worker: ReturnType<typeof spawn> | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(join(dir, "worker.ts"), `import {d1Adapter} from ${JSON.stringify(resolve(base, "src/auth/adapter.ts"))};import {verifyCookieCaller} from ${JSON.stringify(resolve(base, "tests/auth-cookie-scenarios.ts"))};export default{async fetch(request,env){if(new URL(request.url).pathname==='/health')return new Response('ready');try{const statements=[];const counts=await verifyCookieCaller(d1Adapter({prepare:text=>{statements.push(text);return env.DB.prepare(text)}}),'sqlite',async(text,values=[]) => (await env.DB.prepare(text).bind(...values).all()).results,statements);return Response.json({ok:true,counts});}catch(error){return Response.json({error:String(error),stack:error.stack},{status:500});}}};`);
    const config = join(state, "wrangler.json");
    await writeFile(config, JSON.stringify({ name: "mantle-auth-cookie-local", main: join(dir, "worker.ts"), compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "mantle-auth-cookie-local", database_id: "00000000-0000-0000-0000-000000000001" }] }));
    log = await open(join(state, "wrangler.log"), "w");
    worker = spawn("node", [join(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--persist-to", join(state, "state")], { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (worker.exitCode !== null) throw Error(await readFile(join(state, "wrangler.log"), "utf8"));
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(ready).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/verify`, { signal: AbortSignal.timeout(30000) }), result = await response.json() as { ok: boolean; counts: Record<string, number> };
    expect(result).toMatchObject({ ok: true }); expect(response.status).toBe(200);
    expect(result.counts["native:fresh"]).toBe(2); expect(result.counts["native:read-first"]).toBe(1); expect(result.counts["native:read-warm"]).toBe(1); expect(result.counts["renamed:refresh"]).toBe(2); expect(result.counts["secondary:refresh"]).toBe(2);
  } finally {
    if (worker && worker.exitCode === null) { const ended = once(worker, "exit"); try { process.kill(-worker.pid!, "SIGTERM"); } catch {} await ended; }
    await log?.close(); await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
}, 90000);
