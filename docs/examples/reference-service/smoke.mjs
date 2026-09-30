// Runs the service under `wrangler dev` on a fresh local D1 and drives it the way people and agents would: console email-OTP
// sign-in, REST, both MCP surfaces, Admin's API and a cron. Each step asserts what the manifests promise.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const owner = "owner@example.test";
const state = mkdtempSync(join(tmpdir(), "mantle-reference-"));
const wrangler = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
  "--persist-to", state, "--test-scheduled",
  "--var", `PUBLIC_ORIGIN:${origin}`, "--var", `ADMIN_EMAIL:${owner}`, "--var", "BETTER_AUTH_SECRET:reference-smoke-secret-0123456789abcdef"],
// its own process group: pnpm does not pass a signal on to wrangler and workerd, so the group is stopped as one
{ env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let logs = "";
wrangler.stdout.on("data", (chunk) => { logs += chunk; });
wrangler.stderr.on("data", (chunk) => { logs += chunk; });

const json = { "content-type": "application/json", origin };
const call = async (method, path, { cookie, body } = {}) => {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...json, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};
const mcp = async (path, cookie, name, args) => {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name ? "tools/call" : "tools/list", params: name ? { name, arguments: args } : {} }) });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  return { status: response.status, body: data ? JSON.parse(data.slice(5)) : text ? JSON.parse(text) : null };
};

/** Console email OTP: ask for a code, read it from the wrangler log as a developer would, sign in. */
async function signIn(email) {
  const before = logs.length;
  assert.equal((await call("POST", "/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } })).status, 200);
  let code;
  for (let i = 0; i < 40 && !code; i++) {
    code = new RegExp(`${email.replace(/[.+]/g, "\\$&")}[\\s\\S]*?one-time code is (\\d{6})`).exec(logs.slice(before))?.[1];
    if (!code) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(code, `no one-time code for ${email} in the log`);
  const signed = await call("POST", "/api/auth/sign-in/email-otp", { body: { email, otp: code } });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  return signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const stockOf = async () => (await call("GET", "/api/views/catalog")).body.rows[0].stock;
const step = (name) => console.log(`ok - ${name}`);

try {
  for (let attempt = 0; ; attempt++) {
    if (wrangler.exitCode !== null) throw new Error(`wrangler exited ${wrangler.exitCode}`);
    try { if ((await fetch(`${origin}/api/views/catalog`)).status === 200) break; } catch { /* starting */ }
    if (attempt > 240) throw new Error("the Worker did not start");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  step("boot converges a fresh D1 to the plan; the public catalog is empty");

  const staff = await signIn(owner);
  assert.equal((await call("GET", "/admin/api/me", { cookie: staff })).body.role, "owner");
  step("console email OTP signs in; ADMIN_EMAIL becomes the owner");

  for (const qty of [5, 3]) {
    const restocked = await mcp("/admin/api/mcp", staff, "restock", { sku: "TEA-1", name: "Oolong tea", qty });
    assert.equal(restocked.body.result.isError, undefined, JSON.stringify(restocked.body));
  }
  assert.equal(await stockOf(), 8);
  step("staff MCP: restock is an upsert on the unique sku (5 + 3)");

  const itemId = (await call("GET", "/api/views/catalog")).body.rows[0].id;
  assert.equal((await call("POST", "/api/orders", { body: { itemId, qty: 1 } })).status, 401);
  step("an anonymous order is 401");

  const buyer = await signIn("buyer@example.test");
  assert.equal((await call("GET", "/admin/api/me", { cookie: buyer })).status, 403);
  const placed = await call("POST", "/api/orders", { cookie: buyer, body: { itemId, qty: 2 } });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(await stockOf(), 6);
  step("a signed-in buyer (not staff) orders 2: stock 8 -> 6 in one program");

  const tooMany = await call("POST", "/api/orders", { cookie: buyer, body: { itemId, qty: 99 } });
  assert.equal(tooMany.status >= 400 && tooMany.status < 500, true, JSON.stringify(tooMany.body));
  assert.equal(await stockOf(), 6);
  step(`ordering 99 fails the stock >= 0 check (${tooMany.status}) and applies nothing`);

  const mine = (await call("GET", "/api/views/my-orders", { cookie: buyer })).body.rows;
  assert.deepEqual(mine.map(({ qty, orderStatus, item }) => ({ qty, orderStatus, item })), [{ qty: 2, orderStatus: "placed", item: "Oolong tea" }]);
  assert.deepEqual((await call("GET", "/api/views/my-orders", { cookie: staff })).body.rows, []);
  step("my-orders joins items and shows only the caller's own orders (scope)");

  const order = mine[0];
  assert.equal((await call("POST", "/api/orders/cancel", { cookie: staff, body: { orderId: order.id, expectedVersion: order.version } })).status, 409);
  const cancelled = await call("POST", "/api/orders/cancel", { cookie: buyer, body: { orderId: order.id, expectedVersion: order.version } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(await stockOf(), 8);
  assert.equal((await call("POST", "/api/orders/cancel", { cookie: buyer, body: { orderId: order.id, expectedVersion: order.version } })).status, 409);
  step("cancel: another owner's order is a CONFLICT, the owner's returns the stock, a stale version is a CONFLICT");

  assert.deepEqual((await call("GET", "/api/views/search-items?q=oolong")).body.rows.map((r) => r.name), ["Oolong tea"]);
  step("search-items: mantle.search over searchableFields");

  const sales = await call("GET", "/admin/api/views/sales-by-item", { cookie: staff });
  assert.equal(sales.status, 200, JSON.stringify(sales.body));
  assert.equal((await call("GET", "/admin/api/views/sales-by-item", { cookie: buyer })).status, 403);
  step("sales-by-item (GROUP BY over a LEFT JOIN) is staff-only through Admin's API");

  const tools = (await mcp("/mcp", undefined)).body.result.tools.map((t) => t.name);
  assert.ok(tools.includes("place_order") && !tools.includes("restock"), tools.join());
  step("public MCP lists place_order and not the staff restock");

  assert.equal((await fetch(`${origin}/__scheduled?cron=${encodeURIComponent("0 3 * * 1")}`)).status, 200);
  const kinds = (await call("GET", "/admin/api/views/recent-activity", { cookie: staff })).body.rows.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["after_create", "after_update", "weekly-digest"]);
  step("the after hooks recorded the order rows, and Cloudflare's Monday-numbered cron ran the POSIX Sunday digest");

  const version = JSON.parse(readFileSync("node_modules/@aotter/mantle/package.json", "utf8")).version;
  console.log(`Mantle ${version}: reference service passed`);
} catch (error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  const stop = (signal) => { try { process.kill(-wrangler.pid, signal); } catch { /* already gone */ } };
  stop("SIGTERM");
  await new Promise((resolve) => {
    if (wrangler.exitCode !== null) return resolve();
    const timer = setTimeout(() => { stop("SIGKILL"); resolve(); }, 5_000);
    wrangler.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  stop("SIGKILL");
  rmSync(state, { recursive: true, force: true });
}
