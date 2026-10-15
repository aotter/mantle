#!/usr/bin/env node
// A host pipeline that installs with `npm ci --ignore-scripts`, runs `npm run build`, deletes node_modules and uploads
// only the Worker and assets directories. The reference service, from packed packages, builds its Worker and Admin that
// way; then, with node_modules gone, a Wrangler outside the project serves dist/worker and dist/client.
// It runs on Linux in Full checks and release, so Linux's native build binaries install without scripts. The lockfile is
// made on the same machine, so this does not cover a lockfile made on another platform (see the README).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const project = join(root, "docs/examples/reference-service");
const wrangler = `wrangler@${JSON.parse(readFileSync(join(project, "package.json"), "utf8")).devDependencies.wrangler}`;

if (process.argv[2] !== "--serve") {
  const steps = ["npm ci --ignore-scripts --no-audit --no-fund", "npm run generate", "npm run build", "rm -rf node_modules", `node '${import.meta.filename}' --serve`];
  execFileSync(process.execPath, [join(root, "scripts/check-packed-consumer.mjs"), "--pm", "npm", "--project", project, "--", "sh", "-c", steps.join(" && ")],
    { cwd: root, stdio: "inherit", timeout: 900_000 });
  process.exit(0);
}

// --serve: in the built consumer, without node_modules.
if (existsSync("node_modules")) throw new Error("node_modules must be gone before serving");
for (const file of ["dist/worker/index.js", "dist/client/admin/index.html", "dist/client/admin/preview.html", "dist/client/admin/host-bridge.js"]) {
  if (!existsSync(file)) throw new Error(`the build did not write ${file}`);
}
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
delete config.build; // the build already ran; nothing may rebuild from node_modules
writeFileSync("wrangler.serve.json", JSON.stringify(config));
const state = mkdtempSync(join(tmpdir(), "mantle-admin-build-"));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
const npx = (...args) => ["npx", "--yes", wrangler, ...args, "--config", "wrangler.serve.json", "--persist-to", state];
const [d1, ...ddl] = npx("d1", "execute", config.d1_databases[0].database_name, "--local", "--file", "generated/schema.sql");
execFileSync(d1, ddl, { stdio: "inherit", env });
const port = 18000 + Math.floor(Math.random() * 1000), origin = `http://127.0.0.1:${port}`;
const [command, ...args] = npx("dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
  "--var", `PUBLIC_ORIGIN:${origin}`, "--var", "ADMIN_EMAIL:owner@example.test", "--var", "BETTER_AUTH_SECRET:local-smoke-secret-0123456789abcdef");
const server = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let logs = "";
server.stdout.on("data", chunk => { logs += chunk; });
server.stderr.on("data", chunk => { logs += chunk; });
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error(`wrangler exited ${server.exitCode}`);
    try { await fetch(`${origin}/api/auth/ok`); break; } catch { /* starting */ }
    if (attempt > 480) throw new Error("the Worker did not start");
    await new Promise(done => setTimeout(done, 250));
  }
  const expect200 = async path => {
    const response = await fetch(new URL(path, `${origin}/admin/`));
    if (response.status !== 200) throw new Error(`${path}: ${response.status}`);
    return response;
  };
  if ((await fetch(`${origin}/api/auth/ok`)).status !== 200) throw new Error("the Worker's auth route failed");
  const shell = await expect200("/admin/c/items");
  if (shell.headers.get("x-frame-options") !== "DENY") throw new Error("the shell lost its frame refusal");
  const html = await shell.text();
  const script = /<script type="module" crossorigin src="([^"]+)"/.exec(html)?.[1];
  const style = /<link rel="stylesheet" crossorigin href="([^"]+)"/.exec(html)?.[1];
  if (!script || !style) throw new Error(`no entry script or stylesheet in the shell:\n${html.slice(0, 500)}`);
  for (const path of [script, style, "preview.html", "host-bridge.js", "theme.js", "shared/kit.js"]) await expect200(path);
  console.log("ok - built with npm ci --ignore-scripts; Worker and Admin served without node_modules");
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
  rmSync(state, { recursive: true, force: true });
}
