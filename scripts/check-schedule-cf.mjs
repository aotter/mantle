import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "../packages/adapters/cloudflare");
const state = await mkdtemp(resolve(tmpdir(), "mantle-schedule-d1-"));
const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => done(address.port));
  });
});
const child = spawn("pnpm", ["exec", "wrangler", "dev", "--config", "test/fixtures/schedule-wrangler.jsonc", "--test-scheduled", "--persist-to", state, "--local", "--ip", "127.0.0.1", "--port", String(port)], {
  cwd, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error(`Worker did not become ready:\n${output}`);
  const event = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 2 * * *")}&time=1790301600000`);
  if (!event.ok) throw new Error(`Scheduled event returned ${event.status}: ${await event.text()}\n${output}`);
  const replay = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 2 * * *")}&time=1790301600000`);
  if (!replay.ok) throw new Error(`Scheduled replay returned ${replay.status}: ${await replay.text()}\n${output}`);
  const report = await (await fetch(`http://127.0.0.1:${port}/`)).json();
  if (report.seen?.length !== 2 || report.seen.some((id) => id !== "daily-tick:1790301600000")
    || report.runs?.length !== 2 || report.runs[0]?.attempt !== 1 || report.runs[1]?.attempt !== 2
    || report.runs.some((run) => run.status !== "succeeded" || run.runId !== "daily-tick:1790301600000")) {
    throw new Error(`Scheduled Procedure was not invoked with the expected identity: ${JSON.stringify(report)}\n${output}`);
  }
  console.log(JSON.stringify(report));
} finally {
  child.kill("SIGINT");
  await rm(state, { recursive: true, force: true });
}
