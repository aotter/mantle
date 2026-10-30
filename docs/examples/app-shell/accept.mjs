// Independent acceptance setup (mantle help agent-workflow-acceptance): hands each role to a fresh evaluator without a credential.
//   node accept.mjs [--fixtures fixtures.mjs] [--user member@example.test] [--open]
//     Starts the app on a fresh local D1 (schema.sql, then seed.sql), signs the admin in with email OTP, runs the optional
//     fixtures module (default export async ({ call, mcp, signIn, sql, sessions, user }) => {...}: realistic records through
//     the app's own REST/MCP as real users, e.g. other members' orders and more than one page), signs the user in, then
//     serves one local proxy per role that adds that role's session to every request. Give an evaluator only its role's URL
//     (a visitor gets the app's own origin):
//     MCP at <proxy>/mcp (user) or <proxy>/mcp/admin (admin), Admin at <proxy>/admin, pages and REST at <proxy>/.
//     The proxy refuses /api/auth/* so the evaluator cannot sign out, sign in or mint credentials. Ctrl-C stops everything.
//     --open also opens the signed-in admin's Developer UI (<admin proxy>/admin/dev) in the default browser, so a person
//     sees the app's wiring without a one-time code; the app keeps rebuilding on every change under src/ and generated/.
//   node accept.mjs mcp <endpoint> [tool [json-arguments]]
//     A minimal MCP client for an evaluator without one: lists the tools, or calls one and prints the raw result.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (process.argv[2] === "mcp") await client(process.argv[3], process.argv[4], process.argv[5]).catch(error => { console.error(error.message); process.exitCode = 1; });
else await setup();

async function setup() {
  const { values } = parseArgs({ args: process.argv.slice(2).filter(arg => arg !== "--"), options: { fixtures: { type: "string" }, user: { type: "string", default: "member@example.test" }, open: { type: "boolean" } } });
  const { startApp } = await import("./smoke-kit.mjs");
  const app = await startApp();
  const stop = async () => { await app.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // Fixtures run between the two sign-ins, so an invite-only app can admit the user first.
    const sessions = { admin: await app.signIn(app.owner) };
    if (values.fixtures) await (await import(pathToFileURL(resolve(values.fixtures)).href)).default({ ...app, sessions, user: values.user });
    sessions.user = await app.signIn(values.user);
    const lines = [`visitor (anonymous): ${app.origin}`];
    for (const [role, cookie] of Object.entries(sessions)) {
      const url = await proxy(app.origin, cookie);
      if (role === "admin" && values.open) browse(`${url}/admin/dev`);
      lines.push(`${role} (${role === "admin" ? app.owner : values.user}): ${url}  MCP ${url}/mcp${role === "admin" ? "/admin" : ""}${role === "admin" ? `  Admin ${url}/admin` : ""}`);
    }
    console.log(lines.join("\n") + "\nReady. Ctrl-C stops the app and deletes its data.");
  } catch (error) {
    console.error(app.logs().slice(-4000));
    await app.stop();
    throw error;
  }
}

/** Opens a URL in the default browser; without one (CI, a container) the printed URL is all there is. */
function browse(url) {
  const [command, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  spawn(command, [...args, url], { stdio: "ignore", detached: true }).on("error", () => console.log(`Open ${url} in a browser.`)).unref();
}

/** A local origin that forwards to the app with one role's session; sliding Set-Cookie updates stay inside the proxy. */
function proxy(origin, cookie) {
  const jar = new Map(cookie.split("; ").map(pair => [pair.slice(0, pair.indexOf("=")), pair]));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith("/api/auth/")) { response.writeHead(403, { "content-type": "text/plain" }).end("Sign-in is handled by setup."); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (!["host", "cookie", "origin", "connection", "content-length"].includes(name)) headers.set(name, [value].flat().join(", "));
    headers.set("cookie", [...jar.values()].join("; "));
    headers.set("origin", origin);
    const upstream = await fetch(url, { method: request.method, headers, redirect: "manual", body: chunks.length ? Buffer.concat(chunks) : undefined });
    for (const set of upstream.headers.getSetCookie()) { const pair = set.split(";")[0]; jar.set(pair.slice(0, pair.indexOf("=")), pair); }
    const out = {};
    upstream.headers.forEach((value, name) => { if (!["set-cookie", "content-encoding", "content-length", "transfer-encoding"].includes(name)) out[name] = value; });
    if (out.location) out.location = out.location.replace(origin, `http://${request.headers.host}`);
    response.writeHead(upstream.status, out);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(response); else response.end();
  });
  return new Promise(done => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${server.address().port}`)));
}

async function client(endpoint, tool, json) {
  if (!endpoint) throw new Error("usage: node accept.mjs mcp <endpoint> [tool [json-arguments]]");
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++id }), method, params }) });
    const session = response.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    const text = await response.text();
    if (!response.ok && response.status !== 202) throw new Error(`MCP ${method}: HTTP ${response.status} ${text}`);
    const data = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n") || text;
    return data ? JSON.parse(data) : null;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mantle-accept", version: "1" } });
  headers["mcp-protocol-version"] = init.result?.protocolVersion ?? "2025-11-25";
  await rpc("notifications/initialized");
  if (!tool) {
    const tools = [];
    let cursor;
    do { const page = (await rpc("tools/list", cursor ? { cursor } : {})).result; tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    console.log(JSON.stringify(tools, null, 2));
  } else console.log(JSON.stringify(await rpc("tools/call", { name: tool, arguments: json ? JSON.parse(json) : {} }), null, 2));
}
