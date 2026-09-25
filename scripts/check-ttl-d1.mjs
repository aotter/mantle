import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "../packages/adapters/cloudflare");
const state = await mkdtemp(resolve(tmpdir(), "mantle-ttl-d1-"));
const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => done(address.port));
  });
});
const child = spawn("pnpm", ["exec", "wrangler", "dev", "--config", "test/fixtures/ttl-wrangler.jsonc", "--persist-to", state,
  "--local", "--ip", "127.0.0.1", "--port", String(port)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`Worker not ready: ${response.status}`);
      ready = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  if (!ready) throw new Error(`D1 worker did not become ready:\n${output}`);
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(30_000) });
  const report = await response.json();
  if (!response.ok || report.passed !== true) throw new Error(`D1 TTL conformance failed: ${JSON.stringify(report)}\n${output}`);
  console.log(JSON.stringify(report));
} finally {
  child.kill("SIGINT");
  await rm(state, { recursive: true, force: true });
}
