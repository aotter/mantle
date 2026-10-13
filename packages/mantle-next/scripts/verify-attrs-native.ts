/**
 * ADR-0046 spike: the attribute scenarios (tests/attrs-scenarios.ts) inside local workerd on D1 or on postgres.js (Hyperdrive local connection).
 * usage: bun scripts/verify-attrs-native.ts cloudflare-d1|cloudflare-postgres   (the latter needs MANTLE_NEXT_WORKER_PG_URL). Local Wrangler only; port 8998.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { unstable_splitSqlQuery } from "wrangler";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "../tests/apps/link.js";
const base = resolve(import.meta.dir, "..");
const target = process.argv[2] as "cloudflare-d1" | "cloudflare-postgres";
assert.ok(target === "cloudflare-d1" || target === "cloudflare-postgres", "usage: verify-attrs-native.ts cloudflare-d1|cloudflare-postgres");
const postgres = target === "cloudflare-postgres", url = process.env.MANTLE_NEXT_WORKER_PG_URL;
if (postgres) assert.ok(url, "MANTLE_NEXT_WORKER_PG_URL must identify a disposable local database");
const files = await generateOrThrow(target, await loadFixtureSources("attrs.yaml"));
const directory = resolve(base, "tests/apps/.generated", `attrs-${target}`);
await writeGenerated(directory, files, false); // unlinked: imports the built package, as an application does
const ddl = files["schema.sql"]!, schema = `attrs_${Date.now()}_${process.pid}`;
await writeFile(resolve(directory, "worker.ts"), `import * as app from './generated.ts';
import { verifyAttrs } from '${resolve(base, "tests/attrs-scenarios.ts")}';
${postgres ? "import postgres from 'postgres';" : ""}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/health') return new Response('ready');
  const db = ${postgres ? "postgres(env.HYPERDRIVE.connectionString, { max: 1 })" : "env.DB"};
  try {
    ${postgres ? `await db.unsafe('CREATE SCHEMA ${schema}'); await db.unsafe('SET search_path TO ${schema}'); await db.unsafe(${JSON.stringify(ddl)});` : `for (const sql of ${JSON.stringify(unstable_splitSqlQuery(ddl))}) await db.prepare(sql).run();`}
    return Response.json({ checks: await verifyAttrs(app, db) });
  } catch (error) { return Response.json({ error: String(error), actual: error.actual, expected: error.expected }, { status: 500 }); }
  finally { ${postgres ? `await db.unsafe('DROP SCHEMA ${schema} CASCADE').catch(() => {}); await db.end();` : ""} }
} };
`);
const config = { name: "mantle-next-attrs-local", main: resolve(directory, "worker.ts"), compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"],
  ...(postgres ? { hyperdrive: [{ binding: "HYPERDRIVE", id: "00000000000000000000000000000001", localConnectionString: url }] } : { d1_databases: [{ binding: "DB", database_name: "mantle-next-attrs-local", database_id: "00000000-0000-0000-0000-000000000002" }] }) };
const privateDir = await mkdtemp(resolve(process.env.MANTLE_NEXT_LAB_DIR ?? tmpdir(), "mantle-next-attrs-"));
const configPath = resolve(privateDir, "wrangler.private.json");
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await mkdir(resolve(privateDir, "state"), { recursive: true });
const log = await open(resolve(privateDir, "wrangler.log"), "wx", 0o600);
const worker = spawn("node", [resolve(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", configPath, "--ip", "127.0.0.1", "--port", "8998", "--inspector-port", "0", "--persist-to", resolve(privateDir, "state")],
  { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
const exited = once(worker, "exit");
try {
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt++) {
    if (worker.exitCode !== null) throw Error(`local Wrangler exited; see ${privateDir}/wrangler.log`);
    try { ready = (await fetch("http://127.0.0.1:8998/health", { signal: AbortSignal.timeout(1000) })).status === 200; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(ready, `local Wrangler readiness timeout; see ${privateDir}/wrangler.log`);
  const response = await fetch("http://127.0.0.1:8998/run", { signal: AbortSignal.timeout(120000) }), result = await response.json() as { checks?: number };
  assert.equal(response.status, 200, JSON.stringify(result));
  console.log(JSON.stringify({ target, passed: true, ...result }));
} finally {
  try { process.kill(-worker.pid!, "SIGTERM"); } catch {}
  await exited; await log.close();
}
