// Local acceptance kit: runs the app under `wrangler dev --local` on a fresh D1 and drives it over HTTP like a browser or agent.
// Usage in smoke.mjs:
//   import { smoke } from "./smoke-kit.mjs";
//   await smoke(async ({ call, mcp, signIn, owner, step }) => { const admin = await signIn(owner); ... step("..."); });
//   Extra Worker variables: await smoke(scenario, { vars: { SUPPLIER_API_URL: "http://127.0.0.1:9999" } });
// accept.mjs uses startApp() to keep the app running for fresh evaluators.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** The MCP protocol revision this kit speaks. Mantle also serves the 2025 revisions older clients open with. */
export const MCP_REVISION = "2026-07-28";
/** Client capabilities of an MCP Apps host: App resources, `_meta.ui` and App-only tools are listed to it. */
export const APPS_CAPABILITIES = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
/**
 * One MCP request in revision 2026-07-28, as `fetch` options: the `_meta` envelope in the body, and the headers the
 * transport checks against it. `capabilities` are the client capabilities declared (MCP Apps support, say).
 */
export function mcpRequest(method, params = {}, { id = 1, capabilities = {}, headers = {} } = {}) {
  const message = { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_REVISION, "io.modelcontextprotocol/clientInfo": { name: "mantle-smoke", version: "1" }, "io.modelcontextprotocol/clientCapabilities": capabilities, ...params._meta } } };
  const name = method === "tools/call" ? params.name : method === "resources/read" ? params.uri : undefined;
  return { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_REVISION, "mcp-method": method, ...(name === undefined ? {} : { "mcp-name": name }) }, body: JSON.stringify(message) };
}

/**
 * Read-only remote acceptance. Pass generated tools filtered for this surface and the supplied test identity. Checks
 * both protocol eras Mantle serves: `server/discover` and every tools/list page on 2026-07-28, then a 2025-era
 * `initialize` (stateless, no envelope), as a client that has not moved to 2026-07-28 opens.
 */
export async function assertMcpDiscovery(endpoint, { tools, headers = {}, capabilities = APPS_CAPABILITIES }) {
  const expected = tools.map(tool => tool.name).sort();
  assert.equal(new Set(expected).size, expected.length, "expected tools contain duplicate names");
  let id = 0;
  const rpc = async (method, params, legacy = false) => {
    const sent = ++id;
    const request = legacy
      ? { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: sent, method, params }) }
      : mcpRequest(method, params, { id: sent, capabilities, headers });
    const response = await fetch(endpoint, { ...request, redirect: "error", signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `MCP ${method}: HTTP ${response.status}`);
    const text = await response.text(), type = response.headers.get("content-type") ?? "";
    let replies;
    if (type.includes("text/event-stream")) {
      replies = text.replace(/\r\n/g, "\n").split("\n\n").map(event => event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean).map(data => JSON.parse(data));
    } else {
      assert.ok(type.includes("application/json"), `MCP ${method}: expected JSON or SSE`);
      replies = [JSON.parse(text)];
    }
    const matches = replies.filter(reply => reply?.id === sent);
    assert.equal(matches.length, 1, `MCP ${method}: expected one response with the request id`);
    const reply = matches[0];
    assert.equal(reply.jsonrpc, "2.0", `MCP ${method}: invalid JSON-RPC version`);
    assert.ok(!Object.hasOwn(reply, "error"), `MCP ${method}: returned a JSON-RPC error`);
    assert.ok(reply.result && typeof reply.result === "object" && !Array.isArray(reply.result), `MCP ${method}: missing result object`);
    return reply.result;
  };
  const discovered = await rpc("server/discover");
  assert.ok(discovered.supportedVersions?.includes(MCP_REVISION), "MCP server/discover: revision 2026-07-28 not supported");
  assert.ok(discovered.capabilities?.tools && typeof discovered.capabilities.tools === "object" && !Array.isArray(discovered.capabilities.tools), "MCP server/discover: no tools capability");
  const serverInfo = discovered._meta?.["io.modelcontextprotocol/serverInfo"];
  assert.ok(typeof serverInfo?.name === "string" && typeof serverInfo?.version === "string", "MCP server/discover: invalid serverInfo");
  const names = [], cursors = new Set();
  let cursor;
  do {
    assert.ok(cursors.size < 100, "MCP tools/list: exceeded 100 pages");
    const page = await rpc("tools/list", cursor === undefined ? {} : { cursor });
    assert.ok(Array.isArray(page.tools) && page.tools.every(tool => tool && typeof tool.name === "string" && tool.name.length > 0 && tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) && tool.inputSchema.type === "object"), "MCP tools/list: invalid tools");
    names.push(...page.tools.map(tool => tool.name));
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      assert.ok(typeof cursor === "string" && cursor.length > 0 && !cursors.has(cursor), "MCP tools/list: invalid or repeated cursor");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  assert.deepEqual(names.sort(), expected, "MCP tools/list: discovered tools differ from the expected permitted tools");
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mantle-smoke", version: "1" } }, true);
  assert.equal(initialized.protocolVersion, "2025-11-25", "MCP initialize: 2025-11-25 not served");
  assert.ok(initialized.capabilities?.tools && typeof initialized.capabilities.tools === "object" && !Array.isArray(initialized.capabilities.tools), "MCP initialize: no tools capability");
  return names;
}

const database = "DB"; // the D1 binding (wrangler.jsonc d1_databases[0].binding), so renaming the database changes nothing here
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

export async function smoke(scenario, options) {
  const app = await startApp(options);
  try {
    await scenario(app);
    // src/service.ts gives every response without Cache-Control `private, no-store`: a shared cache never keeps it by default.
    assert.deepEqual(app.unstated, [], "responses without Cache-Control");
    console.log("smoke passed");
  } catch (error) {
    console.error(app.logs().slice(-4000));
    throw error;
  } finally { await app.stop(); }
}

/** Start the app on a fresh local D1 (schema.sql, then seed.sql when present); stop() ends wrangler and deletes the state. */
export async function startApp({ vars = {}, port = 18000 + Math.floor(Math.random() * 1000) } = {}) {
  const origin = `http://127.0.0.1:${port}`, owner = "owner@example.test";
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
  const unstated = []; // responses the Worker sent without Cache-Control
  /** method, path, { cookie, body, ip, headers } -> { status, body, headers } */
  const call = async (method, path, { cookie, body, ip, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...(ip ? { "cf-connecting-ip": ip } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    if (!response.headers.has("cache-control")) unstated.push(`${method} ${path} ${response.status}`);
    const text = await response.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  /** MCP tools/list (no name) or tools/call on /mcp or /mcp/admin. */
  const mcp = async (path, cookie, name, args) => {
    const response = await fetch(`${origin}${path}`, mcpRequest(name ? "tools/call" : "tools/list", name ? { name, arguments: args } : {}, { capabilities: APPS_CAPABILITIES, headers: { origin, ...(cookie ? { cookie } : {}) } }));
    if (!response.headers.has("cache-control")) unstated.push(`POST ${path} ${response.status}`);
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
  const stop = async () => {
    const kill = signal => { try { process.kill(-wrangler.pid, signal); } catch { /* already gone */ } };
    kill("SIGTERM");
    await new Promise(resolve => {
      if (wrangler.exitCode !== null) return resolve();
      const timer = setTimeout(() => { kill("SIGKILL"); resolve(); }, 5_000);
      wrangler.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    kill("SIGKILL");
    rmSync(state, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; ; attempt++) {
      if (wrangler.exitCode !== null) throw new Error(`wrangler exited ${wrangler.exitCode}`);
      try { await fetch(`${origin}/api/auth/ok`); break; } catch { /* starting */ }
      if (attempt > 240) throw new Error("the Worker did not start");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    console.error(logs.slice(-4000));
    await stop();
    throw error;
  }
  return { origin, owner, call, mcp, signIn, sql, cron, waitForLog, step, logs: () => logs, unstated, stop };
}
