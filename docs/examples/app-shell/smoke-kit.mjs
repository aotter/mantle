// Local acceptance kit: runs the app under `wrangler dev --local` on a fresh D1 and drives it over HTTP like a browser or agent.
// Usage in smoke.mjs:
//   import { smoke } from "./smoke-kit.mjs";
//   await smoke(async ({ call, mcp, signIn, owner, step }) => { const admin = await signIn(owner); ... step("..."); });
//   Extra Worker variables: await smoke(scenario, { vars: { SUPPLIER_API_URL: "http://127.0.0.1:9999" } });
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const database = "mantle-app"; // wrangler.jsonc d1_databases[0].database_name
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

export async function smoke(scenario, { vars = {} } = {}) {
  const port = 18000 + Math.floor(Math.random() * 1000), origin = `http://127.0.0.1:${port}`, owner = "owner@example.test";
  const state = mkdtempSync(join(tmpdir(), "mantle-smoke-"));
  // Deployment DDL is explicit: nothing at runtime creates tables.
  for (const file of ["generated/schema.sql", ...(existsSync("seed.sql") ? ["seed.sql"] : [])]) {
    const applied = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", database, "--local", "--persist-to", state, "--file", file], { encoding: "utf8", env });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  }
  const wrangler = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--persist-to", state, "--test-scheduled",
    "--var", `PUBLIC_ORIGIN:${origin}`, "--var", `ADMIN_EMAIL:${owner}`, "--var", "BETTER_AUTH_SECRET:local-smoke-secret-0123456789abcdef", ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])],
  // its own process group: pnpm does not pass a signal on to wrangler and workerd
  { env: { ...env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let logs = "";
  wrangler.stdout.on("data", chunk => { logs += chunk; });
  wrangler.stderr.on("data", chunk => { logs += chunk; });

  // Better Auth limits OTP requests to 3 per minute per IP: each signed-in user gets its own client IP.
  const ips = new Map();
  const ipOf = email => ips.get(email) ?? (ips.set(email, `203.0.113.${ips.size + 1}`), ips.get(email));
  /** method, path, { cookie, body, ip, headers } -> { status, body, headers } */
  const call = async (method, path, { cookie, body, ip, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...(ip ? { "cf-connecting-ip": ip } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const text = await response.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  /** MCP tools/list (no name) or tools/call on /mcp or /mcp/admin. */
  const mcp = async (path, cookie, name, args) => {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, accept: "application/json, text/event-stream", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name ? "tools/call" : "tools/list", params: name ? { name, arguments: args } : {} }) });
    const text = await response.text(), data = text.split("\n").find(line => line.startsWith("data:"));
    return { status: response.status, body: data ? JSON.parse(data.slice(5)) : text ? JSON.parse(text) : null };
  };
  /** Console email OTP: request a code, read it from the wrangler log, sign in; returns the cookie header. */
  const signIn = async email => {
    const before = logs.length, ip = ipOf(email);
    assert.equal((await call("POST", "/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" }, ip })).status, 200);
    let code;
    for (let i = 0; i < 40 && !code; i++) {
      code = new RegExp(`${email.replace(/[.+]/g, "\\$&")}[\\s\\S]*?one-time code is (\\d{6})`).exec(logs.slice(before))?.[1];
      if (!code) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(code, `no one-time code for ${email} in the log`);
    const signed = await call("POST", "/api/auth/sign-in/email-otp", { body: { email, otp: code }, ip });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    return signed.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  };
  /** Run SQL against the local D1 (inspect state or inject a failure). Async, so the server's sockets stay serviced. */
  const sql = async command => {
    const { stdout } = await promisify(execFile)("pnpm", ["exec", "wrangler", "d1", "execute", database, "--local", "--persist-to", state, "--command", command, "--json"], { encoding: "utf8", env });
    return JSON.parse(stdout)[0].results;
  };
  /** Fire the Worker's scheduled() handler (wrangler dev --test-scheduled). */
  const cron = async expression => (await fetch(`${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(expression)}`)).status;
  /** Wait until the wrangler log (console.log from the Worker, e.g. ConsoleEmailSender) matches. */
  const waitForLog = async pattern => {
    for (let i = 0; i < 40; i++) { if (pattern.test(logs)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.fail(`no log line matching ${pattern}`);
  };
  const step = name => console.log(`ok - ${name}`);
  try {
    for (let attempt = 0; ; attempt++) {
      if (wrangler.exitCode !== null) throw new Error(`wrangler exited ${wrangler.exitCode}`);
      try { await fetch(`${origin}/api/auth/ok`); break; } catch { /* starting */ }
      if (attempt > 240) throw new Error("the Worker did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await scenario({ origin, owner, call, mcp, signIn, sql, cron, waitForLog, step, logs: () => logs });
    console.log("smoke passed");
  } catch (error) {
    console.error(logs.slice(-4000));
    throw error;
  } finally {
    const stop = signal => { try { process.kill(-wrangler.pid, signal); } catch { /* already gone */ } };
    stop("SIGTERM");
    await new Promise(resolve => {
      if (wrangler.exitCode !== null) return resolve();
      const timer = setTimeout(() => { stop("SIGKILL"); resolve(); }, 5_000);
      wrangler.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    stop("SIGKILL");
    rmSync(state, { recursive: true, force: true });
  }
}
