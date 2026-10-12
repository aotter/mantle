import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import postgres from "postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { d1Shim } from "./apps/d1-shim.js";
import { source, staff, exerciseEntries, exerciseNullableOrder, exerciseIntegerEntries, exerciseEntryRace } from "./admin-entries-scenarios.js";
for (const target of ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const) {
    const sqlite = !target.endsWith("postgres"), pg = process.env.MANTLE_NEXT_BUN_PG_URL;
    (sqlite || pg ? test : test.skip)(`${target} native Admin CRUD, wire, nullable order, OCC, locales and export`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "mantle-entries-")), files = await generateOrThrow(target, [{ sourceId: "entries.yaml", text: source }]), schema = "entries_" + crypto.randomUUID().replaceAll("-", "");
        const db: any = sqlite ? new Database(":memory:") : target === "cloudflare-postgres" ? postgres(pg!, { max: 1, onnotice: () => { } }) : new SQL(pg!, { max: 1 });
        try {
            await writeGenerated(dir, files);
            if (sqlite)
                db.exec(files["schema.sql"]! + files["admin-schema.sql"]!);
            else {
                await db.unsafe(`CREATE SCHEMA ${schema}`);
                await db.unsafe(`SET search_path TO ${schema}`);
                await db.unsafe(files["schema.sql"]! + files["admin-schema.sql"]!);
            }
            let queries = 0, hook: undefined | (() => Promise<unknown>);
            const arm = (next: () => Promise<unknown>) => { hook = next; };
            const sql = async (text: string, binds: unknown[] = []) => sqlite ? db.query(text).all(...binds) : db.unsafe(text, binds);
            const tapped = sqlite ? { query(text: string) { if (!text.startsWith("SELECT changes()"))
                    queries++; const statement = db.query(text); return new Proxy(statement, { get(target, method) { if (method === "all")
                        return (...values: unknown[]) => { const result = target.all(...values); if (hook && text.startsWith("SELECT") && text.includes("LIMIT 1")) {
                            const next = hook;
                            hook = undefined;
                            void next();
                        } return result; }; const value = Reflect.get(target, method, target); return typeof value === "function" ? value.bind(target) : value; } }); }, exec: db.exec.bind(db), transaction: db.transaction.bind(db) } : undefined;
            const handle = target === "cloudflare-d1" ? d1Shim(tapped as Database) : sqlite ? tapped : { async unsafe(text: string, values: unknown[]) { queries++; const result = await db.unsafe(text, values); if (hook && text.startsWith("SELECT") && text.includes("LIMIT 1")) {
                    const next = hook;
                    hook = undefined;
                    await next();
                } return result; }, begin: db.begin.bind(db) };
            const { admin } = await import(join(dir, "admin.ts"));
            const native = await import(join(dir, "generated.ts"));
            const app = admin({ db: () => handle, caller: async () => staff });
            expect(await exerciseEntries(app, sql, () => queries, sqlite)).toEqual({ ok: true });
            await exerciseIntegerEntries(app, sql, () => queries, sqlite);
            const table = native.store(handle, staff).collection("articles");
            await exerciseNullableOrder(table, sql, () => queries, sqlite);
            await exerciseEntryRace(app, sql, arm, sqlite);
            const before = queries;
            await expect(table.find({ nulls: "bad" })).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
            expect(queries).toBe(before);
        }
        finally {
            if (sqlite)
                db.close();
            else {
                await db.unsafe(`DROP SCHEMA ${schema} CASCADE`);
                if (target === "cloudflare-postgres")
                    await db.end();
                else
                    await db.close();
            }
            await rm(dir, { recursive: true, force: true });
        }
    }, 30000);
}
(process.env.MANTLE_NEXT_ADMIN_ENTRIES_D1 ? test : test.skip)("Admin entries execute on actual local D1", async () => {
    const { unstable_splitSqlQuery } = await import("wrangler"), { spawn } = await import("node:child_process"), { once } = await import("node:events"), { open, writeFile, readFile } = await import("node:fs/promises"), { resolve } = await import("node:path");
    const base = resolve(import.meta.dir, ".."), dir = await mkdtemp(join(base, "tests/apps/.entries-d1-")), privateDir = await mkdtemp(join(tmpdir(), "mantle-entries-d1-")), port = process.env.MANTLE_NEXT_ADMIN_ENTRIES_PORT ?? "8996";
    let worker: ReturnType<typeof spawn> | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
    try {
        const files = await generateOrThrow("cloudflare-d1", [{ sourceId: "entries.yaml", text: source }]);
        await writeGenerated(dir, files, false);
        await writeFile(join(dir, "worker.ts"), `import {admin} from './admin.js';import {store} from './generated.js';import {exerciseEntries,exerciseNullableOrder,exerciseIntegerEntries,exerciseEntryRace,staff} from ${JSON.stringify(resolve(import.meta.dir, "admin-entries-scenarios.ts"))};
export default{async fetch(request:Request,env:{DB:any}){if(new URL(request.url).pathname==='/health')return new Response('ready');try{
 for(const sql of ${JSON.stringify(unstable_splitSqlQuery(files["schema.sql"]! + files["admin-schema.sql"]!))})await env.DB.prepare(sql).run();
 let queries=0,hook:undefined|(()=>Promise<unknown>);const arm=(next:()=>Promise<unknown>)=>{hook=next;};const db={prepare(text:string){const original=env.DB.prepare(text);return{original,bind(...values:unknown[]){return{original:original.bind(...values),async all(){queries++;const result=await this.original.all();if(hook&&text.startsWith("SELECT")&&text.includes("LIMIT 1")){const next=hook;hook=undefined;await next();}return result;}};} };},async batch(statements:any[]){queries++;return env.DB.batch(statements.map(s=>s.original));}};
 const app=admin({db:()=>db,caller:async()=>(${JSON.stringify(staff)})});const sql=async(text:string,values:unknown[]=[])=>{const out=await env.DB.prepare(text).bind(...values).all();return out.results;};await exerciseEntries(app,sql,()=>queries,true);await exerciseIntegerEntries(app,sql,()=>queries,true);await exerciseNullableOrder(store(db,staff).collection("articles"),sql,()=>queries,true);await exerciseEntryRace(app,sql,arm,true);return Response.json({ok:true});
}catch(error){return Response.json({error:String(error)},{status:500});}}};`);
        const config = join(privateDir, "wrangler.json");
        await writeFile(config, JSON.stringify({ name: "mantle-entries-local", main: join(dir, "worker.ts"), compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "mantle-entries-local", database_id: "00000000-0000-0000-0000-000000000001" }] }));
        log = await open(join(privateDir, "wrangler.log"), "w");
        worker = spawn("node", [join(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--persist-to", join(privateDir, "state")], { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
        let ready = false;
        for (let i = 0; i < 60; i++) {
            if (worker.exitCode !== null)
                throw Error(await readFile(join(privateDir, "wrangler.log"), "utf8"));
            try {
                ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
            }
            catch { }
            if (ready)
                break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        expect(ready).toBe(true);
        const response = await fetch(`http://127.0.0.1:${port}/verify`, { signal: AbortSignal.timeout(30000) });
        expect(await response.json()).toEqual({ ok: true });
        expect(response.status).toBe(200);
    }
    finally {
        if (worker && worker.exitCode === null) {
            const ended = once(worker, "exit");
            try {
                process.kill(-worker.pid!, "SIGTERM");
            }
            catch { }
            await ended;
        }
        await log?.close();
        await rm(dir, { recursive: true, force: true });
        await rm(privateDir, { recursive: true, force: true });
    }
}, 90000);
