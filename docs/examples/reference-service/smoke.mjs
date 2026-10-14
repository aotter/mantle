// Runs the service under `wrangler dev` on a fresh local D1 and drives it the way people and agents would: console email-OTP
// sign-in, REST, both MCP surfaces, Admin's API and a cron. Each step asserts what the manifests promise.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const owner = "owner@example.test";
const state = mkdtempSync(join(tmpdir(), "mantle-reference-"));
// Deployment preparation is explicit; no import or request converges storage.
for (const file of ["generated/schema.sql"]) {
  const applied = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", "mantle-reference", "--local", "--persist-to", state, "--file", file], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
}
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
  assert.deepEqual((await call("GET", "/api/views/catalog")).body.rows, []);
  step("explicit deployment DDL prepared a fresh D1; the public catalog is empty");

  const admin = await signIn(owner);
  assert.equal((await call("GET", "/admin/api/me", { cookie: admin })).body.role.split(",")[0], "admin");
  step("console email OTP signs in; verified ADMIN_EMAIL becomes admin");
  const resourceMetadata = await call("GET", "/.well-known/oauth-protected-resource/mcp");
  assert.equal(resourceMetadata.status, 200, JSON.stringify(resourceMetadata.body));
  assert.equal(resourceMetadata.body.resource, `${origin}/mcp`);

  for (const qty of [5, 3]) {
    const restocked = await mcp("/mcp/admin", admin, "restock", { sku: "TEA-1", name: "Oolong tea", qty });
    assert.equal(restocked.body.result.isError, undefined, JSON.stringify(restocked.body));
  }
  assert.equal(await stockOf(), 8);
  step("admin MCP: restock is an upsert on the unique sku (5 + 3)");

  const itemId = (await call("GET", "/api/views/catalog")).body.rows[0].id;
  assert.equal((await call("POST", "/api/orders", { body: { itemId, qty: 1 } })).status, 401);
  step("an anonymous order is 401");

  const buyer = await signIn("buyer@example.test");
  assert.equal((await call("GET", "/admin/api/me", { cookie: buyer })).status, 403);
  const placed = await call("POST", "/api/orders", { cookie: buyer, body: { itemId, qty: 2 } });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.equal(await stockOf(), 6);
  step("a signed-in buyer (not admin) orders 2: stock 8 -> 6 in one program");

  const tooMany = await call("POST", "/api/orders", { cookie: buyer, body: { itemId, qty: 99 } });
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));
  assert.match(tooMany.body.error.message, /CHECK items: stock >= 0/);
  assert.equal(await stockOf(), 6);
  step("ordering 99 fails the stock >= 0 check in the second statement, and the order the first wrote is rolled back");

  const mine = (await call("GET", "/api/views/my-orders", { cookie: buyer })).body.rows;
  assert.deepEqual(mine.map(({ qty, orderStatus, item }) => ({ qty, orderStatus, item })), [{ qty: 2, orderStatus: "placed", item: "Oolong tea" }]);
  assert.deepEqual((await call("GET", "/api/views/my-orders", { cookie: admin })).body.rows, []);
  step("my-orders joins items and shows only the caller's own orders (scope)");

  const order = mine[0];
  assert.equal((await call("POST", "/api/orders/cancel", { cookie: admin, body: { orderId: order.id, expectedVersion: order.version } })).status, 409);
  const cancelled = await call("POST", "/api/orders/cancel", { cookie: buyer, body: { orderId: order.id, expectedVersion: order.version } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(await stockOf(), 8);
  assert.equal((await call("POST", "/api/orders/cancel", { cookie: buyer, body: { orderId: order.id, expectedVersion: order.version } })).status, 409);
  step("cancel: another owner's order is a CONFLICT, the owner's returns the stock, a stale version is a CONFLICT");

  assert.deepEqual((await call("GET", "/api/views/search-items?q=oolong")).body.rows.map((r) => r.name), ["Oolong tea"]);
  step("search-items: mantle.search over searchableFields");

  const sales = await call("GET", "/admin/api/views/sales-by-item", { cookie: admin });
  assert.deepEqual(sales.body.rows, [{ name: "Oolong tea", orders: 0, units: 0 }], JSON.stringify(sales.body));
  assert.equal((await call("GET", "/admin/api/views/sales-by-item", { cookie: buyer })).status, 403);
  step("sales-by-item (GROUP BY over a LEFT JOIN) is admin-only through Admin's API");

  // the console: @aotter/mantle-admin assets served by the application at /admin, its assets by name, any other path its client-side route
  const shell = await fetch(`${origin}/admin/c/items`);
  const html = await shell.text();
  const script = /src="((?:\/admin\/|\.\/)assets\/[^"]+\.js)"/.exec(html)?.[1];
  const base = /<base href="([^"]+)"/.exec(html)?.[1] ?? "/admin/";
  assert.equal(shell.headers.get("x-frame-options"), "DENY");
  assert.match(shell.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${origin}/admin/..%2f..%2fsecret.txt`)).status, 404);
  assert.ok(script, html.slice(0, 300));
  const scriptUrl = new URL(script, new URL(base, origin));
  assert.equal(scriptUrl.origin, origin);
  assert.ok(scriptUrl.pathname.startsWith("/admin/assets/"));
  assert.equal((await fetch(scriptUrl)).status, 200);
  assert.equal((await fetch(`${origin}/admin/assets/missing.js`)).status, 404);
  // the editor's round trip: it reads the whole entry and writes it back, an unset optional field included as null
  const [tea] = (await call("GET", "/admin/api/entries?collection=items", { cookie: admin })).body.items;
  assert.deepEqual({name:tea.data.name,sku:tea.data.sku,stock:tea.data.stock}, { name: "Oolong tea", sku: "TEA-1", stock: 8 });
  const { entry } = (await call("GET", `/admin/api/entries/${tea.id}?collection=items`, { cookie: admin })).body;
  const saved = await call("PATCH", `/admin/api/entries/${tea.id}?collection=items`, { cookie: admin, body: { expectedVersion: entry.version, data: { ...entry.data, name: "Oolong tea (Taiwan)", priceCents: null } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await call("GET", "/api/views/catalog")).body.rows[0].name, "Oolong tea (Taiwan)");
  step("Admin's console: the SPA and its assets at /admin, the list's declared columns, and an editor's save of the whole entry");

  const tools = (await mcp("/mcp", undefined)).body.result.tools.map((t) => t.name);
  assert.ok(tools.includes("place_order") && !tools.includes("restock"), tools.join());
  step("public MCP lists place_order and not the admin restock");

  assert.equal((await fetch(`${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("0 3 * * 1")}`)).status, 200);
  const activity = (await call("GET", "/admin/api/views/recent-activity", { cookie: admin })).body.rows;
  assert.deepEqual(activity.map((r) => r.kind).sort(), ["after_create", "after_update", "weekly-digest"]);
  // the one order was cancelled, and the digest counts placed orders only
  assert.equal(activity.find((r) => r.kind === "weekly-digest").detail, "0 orders, 0 units");
  step("the app-owned after effects recorded the order rows, and Cloudflare's Monday-numbered cron ran the POSIX Sunday digest");

  const bootstrap = (await call("GET", "/admin/api/bootstrap", { cookie: admin })).body;
  assert.ok(bootstrap.views.some(view => view.name === "sales-by-item"));
  assert.ok(bootstrap.webmcp.tools.some(tool => tool.name === "sales_by_item"));
  assert.equal((await call("GET", "/api/views/sales-by-item")).status, 404);
  assert.equal((await call("GET", "/admin/api/views/sales-by-item")).status, 401);
  for (const [sku, name] of [["TEA-2", "A tea"], ["TEA-3", "A tea"], ["TEA-4", "Z tea"]]) {
    const stocked = await mcp("/mcp/admin", admin, "restock", { sku, name, qty: 5 });
    assert.equal(stocked.body.result.isError, undefined, JSON.stringify(stocked.body));
  }
  const walk = async (path, cookie) => {
    const rows = []; let cursor;
    for (let pages = 0; pages < 10; pages++) {
      const page = await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cookie });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(page.body.rows.length <= 1);
      rows.push(...page.body.rows); cursor = page.body.nextCursor;
      if (!cursor) return rows;
    }
    assert.fail("cursor walk did not terminate");
  };
  const fullSearch = (await call("GET", "/api/views/search-items?q=tea&limit=500")).body.rows;
  assert.equal(fullSearch.length, 4);
  assert.deepEqual(await walk("/api/views/search-items?q=tea"), fullSearch);
  assert.equal(new Set(fullSearch.map(row => row.id)).size, 4);
  const firstSearch = (await call("GET", "/api/views/search-items?q=tea&limit=1")).body;
  assert.equal((await call("GET", `/api/views/search-items?q=oolong&cursor=${encodeURIComponent(firstSearch.nextCursor)}`)).status, 400);
  assert.equal((await call("GET", "/api/views/search-items?q=tea&cursor=malformed")).status, 400);
  const fullSales = (await call("GET", "/admin/api/views/sales-by-item?limit=500", { cookie: admin })).body.rows;
  assert.equal(fullSales.length, 3); // identical item names form one complete group
  assert.deepEqual(await walk("/admin/api/views/sales-by-item", admin), fullSales);
  assert.equal((await call("GET", `/admin/api/views/sales-by-item?cursor=${encodeURIComponent(firstSearch.nextCursor)}`, { cookie: admin })).status, 400);
  assert.deepEqual((await call("POST", "/admin/api/webmcp/sales_by_item", { cookie: admin, body: {} })).body.output.rows, fullSales);
  const searchedTool = await mcp("/mcp", undefined, "search_items", { q: "tea", limit: 1 });
  assert.equal(searchedTool.body.result.isError, undefined, JSON.stringify(searchedTool.body));
  assert.equal(searchedTool.body.result.structuredContent.rows.length, 1);
  assert.ok(!(await mcp("/mcp", undefined)).body.result.tools.some(tool => tool.name === "sales_by_item"));
  step("computed relevance and grouped SQL keysets preserve ties, pages, scope, metadata and WebMCP; malformed/foreign cursors refuse");

  const createdForAdmin = await call("POST", "/api/orders", { cookie: admin, body: { itemId, qty: 1 } });
  assert.equal(createdForAdmin.status, 200, JSON.stringify(createdForAdmin.body));
  const [adminOrder] = (await call("GET", "/api/views/my-orders", { cookie: admin })).body.rows;
  const editedOrder = await call("PATCH", `/admin/api/%65ntries/${adminOrder.id}/?collection=ORDERS`, { cookie: admin, body: { expectedVersion: adminOrder.version, data: { qty: 3 } } });
  assert.equal(editedOrder.status, 200, JSON.stringify(editedOrder.body));
  const affected = (await call("GET", "/admin/api/views/recent-activity", { cookie: admin })).body.rows.filter(row => row.subject === adminOrder.id);
  assert.deepEqual(affected.map(row => row.detail).sort(), ["placed x1", "placed x3"]);
  const execute = command => {
    const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", "mantle-reference", "--local", "--persist-to", state, "--command", command, "--json"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout)[0].results;
  };
  const actors = execute(`SELECT DISTINCT u.email FROM activity a JOIN user u ON u.id = a.author_id WHERE a.subject = '${adminOrder.id}'`);
  assert.deepEqual(actors, [{ email: owner }]);
  execute("CREATE TRIGGER reference_fail_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'synthetic after failure'); END");
  const beforeFailure = (await call("GET", "/api/views/catalog")).body.rows.find(row => row.id === itemId).stock;
  const committed = await call("POST", "/api/orders", { cookie: admin, body: { itemId, qty: 1 } });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal((await call("GET", "/api/views/catalog")).body.rows.find(row => row.id === itemId).stock, beforeFailure - 1);
  assert.equal((await call("GET", "/api/views/my-orders", { cookie: admin })).body.rows.length, 2);
  execute("DROP TRIGGER reference_fail_activity");
  step("Admin affected rows record the actual caller; failed after effects preserve committed stock/order and never retry the business write");

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
