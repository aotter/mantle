/** Runs a Worker source against a fresh local D1 under `wrangler dev` and returns what GET /verify answers. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = resolve(import.meta.dir, "../..");

export async function verifyOnLocalD1(dir: string, worker: string, port: string): Promise<unknown> {
  const state = await mkdtemp(join(tmpdir(), "mantle-local-d1-")), config = join(state, "wrangler.json");
  await writeFile(join(dir, "worker.ts"), worker);
  await writeFile(config, JSON.stringify({ name: "mantle-local-d1", main: join(dir, "worker.ts"), compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "mantle-local-d1", database_id: "00000000-0000-0000-0000-000000000001" }] }));
  const log = await open(join(state, "wrangler.log"), "w");
  const child = spawn("node", [join(base, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--config", config, "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--persist-to", join(state, "state")], { cwd: base, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }, stdio: ["ignore", log.fd, log.fd] });
  try {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw Error(await readFile(join(state, "wrangler.log"), "utf8"));
      try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) return await (await fetch(`http://127.0.0.1:${port}/verify`, { signal: AbortSignal.timeout(30000) })).json(); } catch {}
      await new Promise(done => setTimeout(done, 1000));
    }
    throw Error(`local D1 Worker did not start on port ${port}`);
  } finally {
    if (child.exitCode === null) { const ended = once(child, "exit"); try { process.kill(-child.pid!, "SIGTERM"); } catch {} await ended; }
    await log.close(); await rm(state, { recursive: true, force: true });
  }
}
