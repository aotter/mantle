import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "../packages/adapters/cloudflare");
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolvePort(address.port));
  });
});
const child = spawn("pnpm", ["exec", "wrangler", "dev", "--config", "test/fixtures/atomic-wrangler.jsonc", "--local", "--ip", "127.0.0.1", "--port", String(port)], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let report;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      report = await response.json();
      if (!response.ok || report.passed !== true) throw new Error(`D1 conformance failed: ${JSON.stringify(report)}`);
      break;
    } catch (error) {
      if (error.message.startsWith("D1 conformance failed")) throw error;
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  if (!report) throw new Error(`D1 workerd did not become ready:\n${output}`);
  console.log(JSON.stringify(report));
} finally {
  child.kill("SIGINT");
}
