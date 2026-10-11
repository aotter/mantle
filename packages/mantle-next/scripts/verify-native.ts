/** Local official drivers only; requires explicit disposable PostgreSQL DSNs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, mkdtemp, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { unstable_splitSqlQuery } from "wrangler";
import { generateFromSources } from "../src/infrastructure/generate.js";
import type { Target } from "../src/domain/model.js";
import { externalReadBenchmark } from "./bench.js";
import type { Caller } from "../src/kernel/contracts.js";
import { verifyBareApplication, postgresOracleSql, handwrittenListSql } from "../tests/native-scenarios.js";
const base = resolve(import.meta.dir, "..");
const targets: Target[] = ["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"];
const args = process.argv.slice(2);
const selected = args.find(arg => arg !== "--bench");
const includeBench = args.includes("--bench");
if (includeBench) {
  assert.equal(process.env.MANTLE_NEXT_QUIET_SLOT, "1", "benchmark requires a coordinated quiet slot");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" }).trim(), "", "formal benchmark source must be committed and clean");
}
assert.ok(!selected || targets.includes(selected as Target), "unknown native target");
const caller = (owner: string | null): Caller => owner === null ? { kind: "anonymous" } : { kind: "user", subject: owner, role: null, scopes: [], credential: "session", credentialId: null, clientId: null };
const source = await readFile(resolve(base, "tests/apps/purchase.yaml"), "utf8");
for (const target of selected ? [selected as Target] : targets) {
  const generated = await generateFromSources({ target, sources: { sources: [{ sourceId: "purchase.yaml", text: source }] } });
  assert.ok(generated.ok, JSON.stringify(!generated.ok && generated.diagnostics));
  const directory = resolve(base, "tests/apps/.generated", target);
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(generated.files)) {
    await mkdir(dirname(resolve(directory, name)), { recursive: true });
    await writeFile(resolve(directory, name), text);
  }
  const bare = await import(pathToFileURL(resolve(directory, "generated.ts")).href);
  for (const kind of ["views", "procedures"]) for (const name of Object.keys(bare[kind])) {
    const entry = await import(pathToFileURL(resolve(directory, kind, encodeURIComponent(name) + ".ts")).href);
    assert.equal(entry.default, bare[kind][name], "direct entry must reference the same generated function");
  }
  // Record the actual generated driver call for an exact-SQL native control.
  let canonicalSql = ""; let canonicalCalls = 0;
  const record = (sql:string,values:unknown[]) => { canonicalSql=sql; canonicalCalls++; assert.deepEqual(values,["purchase-owner-a"]); return []; };
  const capture = target === "bun-sqlite" ? {query:(sql:string)=>({all:(...values:unknown[])=>record(sql,values)})}
    : target === "cloudflare-d1" ? {prepare:(sql:string)=>({bind:(...values:unknown[])=>({all:async()=>({results:record(sql,values)})})})}
    : {unsafe:async(text:string,values:unknown[])=>record(text,values)};
  await bare.views["purchase-list"](capture,caller("purchase-owner-a"),{});
  assert.equal(canonicalCalls,1,"bare View uses exactly one native read");
  const ddl = generated.files["schema.sql"]!;
  let result: unknown;
  if (target === "bun-sqlite") {
    const db = new Database(":memory:");
    try {
      db.exec(ddl);
      result = await verifyBareApplication((kind,name,owner,input) => bare[kind === "view" ? "views" : "procedures"][name](db,caller(owner),input), async (sql,values=[]) => db.query(sql).all(...values as any[]) as Record<string,unknown>[], true, includeBench);
    } finally { db.close(); }
  } else if (target === "bun-postgres") {
    const connectionString = process.env.MANTLE_NEXT_BUN_PG_URL;
    assert.ok(connectionString, "MANTLE_NEXT_BUN_PG_URL must identify a disposable local database");
    const sql = new SQL({ url: connectionString, max: 1 });
    try {
      const schema = `mantle_next_${Date.now()}_${process.pid}`;
      await sql.unsafe(`CREATE SCHEMA ${schema}`); await sql.unsafe(`SET search_path TO ${schema}`); await sql.unsafe(ddl);
      result = await verifyBareApplication((kind,name,owner,input) => bare[kind === "view" ? "views" : "procedures"][name](sql,caller(owner),input), async (text,values=[]) => sql.unsafe(postgresOracleSql(text),[...values]), false, includeBench);
    } finally { await sql.close(); }
  } else {
    const postgres = target === "cloudflare-postgres";
    const connectionString = process.env.MANTLE_NEXT_WORKER_PG_URL;
    if (postgres) assert.ok(connectionString, "MANTLE_NEXT_WORKER_PG_URL must identify a disposable local database");
    const workerFile = resolve(directory, "worker.ts");
    const schema = `mantle_next_${Date.now()}_${process.pid}`;
    const sql = unstable_splitSqlQuery(ddl);
    await writeFile(workerFile, `import { views as bareViews, procedures as bareProcedures } from './generated.ts';\nimport { verifyBareApplication, postgresOracleSql, handwrittenListSql } from '${resolve(base, "tests/native-scenarios.ts")}';\n${postgres ? `import { Client } from 'pg';\nimport { pgPort } from '${resolve(base, "tests/apps/pg-port.ts")}';` : ""}\nexport default { async fetch(_request, env) {\n if (new URL(_request.url).pathname === '/health') return new Response('ready');\n const db = ${postgres ? "new Client({connectionString:env.HYPERDRIVE.connectionString})" : "env.DB"};\n try {\n${postgres ? ` await db.connect(); if (!new URL(_request.url).pathname.startsWith('/read-')) { await db.query('CREATE SCHEMA ${schema}'); await db.query('SET search_path TO ${schema}'); await db.query(${JSON.stringify(ddl)}); }` : ` if (!new URL(_request.url).pathname.startsWith('/read-')) for (const sql of ${JSON.stringify(sql)}) await db.prepare(sql).run();`}\n if (new URL(_request.url).pathname.startsWith('/read-')) {\n   ${postgres ? `await db.query('SET search_path TO ${schema}');` : ''}\n   const subject='purchase-owner-a'; const owner={kind:'user',subject,role:null,scopes:[],credential:'session',credentialId:null,clientId:null};\n   let rows; for(let batch=0;batch<20;batch++){\n     if(new URL(_request.url).pathname === '/read-generated') rows=await bareViews['purchase-list'](${postgres ? "pgPort(db)" : "db"},owner,{});\n     else { if(owner.kind !== 'user') throw new Error('UNAUTHENTICATED'); const text=new URL(_request.url).pathname === '/read-native-canonical' ? ${JSON.stringify(canonicalSql)} : ${postgres ? "postgresOracleSql(handwrittenListSql(false))" : "handwrittenListSql(true)"}; rows=${postgres ? "(await db.query({text,values:[subject]})).rows" : "(await db.prepare(text).bind(subject).all()).results"}; }\n   }\n   return Response.json(rows);\n }\n const result = await verifyBareApplication((kind,name,owner,input) => (kind==='view'?bareViews:bareProcedures)[name](${postgres ? "pgPort(db)" : "db"},owner===null?{kind:'anonymous'}:{kind:'user',subject:owner,role:null,scopes:[],credential:'session',credentialId:null,clientId:null},input), async (sql,values=[]) => ${postgres ? "pgPort(db).unsafe(postgresOracleSql(sql),values)" : "(await db.prepare(sql).bind(...values).all()).results"}, ${!postgres}, ${includeBench});\n return Response.json(result);\n } catch(error) { return Response.json({error:String(error),stack:error.stack,actual:Array.isArray(error.actual)?error.actual[0]:error.actual,expected:Array.isArray(error.expected)?error.expected[0]:error.expected},{status:500}); } finally { ${postgres ? "await db.end();" : ""} }\n} };\n`);
    const config = { name: "mantle-next-native-local", main: workerFile, compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"], ...(postgres ? { hyperdrive: [{ binding: "HYPERDRIVE", id: "00000000000000000000000000000001", localConnectionString: connectionString }] } : { d1_databases: [{ binding: "DB", database_name: "mantle-next-local", database_id: "00000000-0000-0000-0000-000000000001" }] }) };
    const privateDir = await mkdtemp(resolve(process.env.MANTLE_NEXT_LAB_DIR ?? tmpdir(), "mantle-next-native-"));
    const configPath = resolve(privateDir, "wrangler.private.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const log = await open(resolve(privateDir, "wrangler.log"), "wx", 0o600);
    const worker = spawn("node", [resolve(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", configPath, "--ip", "127.0.0.1", "--port", "8998", "--inspector-port", "0", "--persist-to", resolve(privateDir, "state")], { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
    const exited = once(worker, "exit");
    try {
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        if (worker.exitCode !== null) throw Error("local Wrangler exited; inspect private wrangler.log");
        try { const response = await fetch("http://127.0.0.1:8998/health", { signal: AbortSignal.timeout(1000) }); ready = response.status === 200; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.ok(ready, "actual local Wrangler readiness timeout; inspect private wrangler.log");
      const response = await fetch("http://127.0.0.1:8998/verify", { signal: AbortSignal.timeout(120000) }); result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
      if (includeBench) (result as any).externalBenchmark = await externalReadBenchmark("http://127.0.0.1:8998");
    } finally {
      try { process.kill(-worker.pid!, "SIGTERM"); } catch {}
      await exited; await log.close();
    }
  }
  if (includeBench) {
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const harnessFiles = ["scripts/verify-native.ts", "scripts/bench.ts", "tests/native-scenarios.ts", "tests/apps/fixtures.ts"];
    const harnessHashes = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [file, hash(await readFile(resolve(base, file), "utf8"))])));
    const provenance = { canonicalSQLSHA256:hash(canonicalSql), canonicalSql, harnessHashes, gitSHA: execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).trim(), generatedSHA256: hash(generated.files["generated.ts"]!), schemaSHA256: hash(ddl), fixtureSHA256: hash(source), contractsSHA256: hash(await readFile(resolve(base, "dist/kernel/contracts.js"), "utf8")), runtime: process.version, bun: Bun.version, timestampUTC: new Date().toISOString() };
    const output = process.env.MANTLE_NEXT_BENCH_OUTPUT;
    assert.ok(output, "MANTLE_NEXT_BENCH_OUTPUT must be a private fresh output directory");
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, target + ".json"), JSON.stringify({ target, provenance, ...result as object }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  const report = result as { checks: number; seededRows: number; benchmark?: { summary: unknown } };
  console.log(JSON.stringify({ target, passed: true, checks: report.checks, seededRows: report.seededRows, ...(report.benchmark ? { bareBenchmark: report.benchmark.summary, externalBenchmark:(result as any).externalBenchmark?.summary } : {}) }));
}
