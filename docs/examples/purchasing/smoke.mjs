// Purchase requests end to end: submit, guarded transitions, admin-only approve/reject (Admin + admin MCP),
// optimistic concurrency, one-transaction approval with a budget check, supplier order + signed callback, emails, cron.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { smoke } from "./smoke-kit.mjs";

const SECRET = "local-supplier-secret", DAILY = "0 9 * * *", DAY_US = 86_400 * 1_000_000;

// A stand-in supplier API: accepts an order and answers with its order id.
const received = [];
const supplier = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    received.push({ ...JSON.parse(body), idempotencyKey: request.headers["idempotency-key"] });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ orderId: `SUP-${received.length}` }));
  });
});
await new Promise(resolve => supplier.listen(0, "127.0.0.1", resolve));
// smoke-kit passes only the shell's variables; the supplier's reach the Worker through .dev.vars (restored afterwards).
const saved = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : undefined;
writeFileSync(".dev.vars", `SUPPLIER_API_URL=http://127.0.0.1:${supplier.address().port}/orders\nSUPPLIER_WEBHOOK_SECRET=${SECRET}\n`);

try {
  await smoke(async ({ origin, owner, call, mcp, signIn, sql, step, logs }) => {
    const waitForLog = async pattern => {
      for (let i = 0; i < 40; i++) { if (pattern.test(logs())) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.fail(`no log line matching ${pattern}`);
    };
    // sql() blocks Node while wrangler runs; yield afterwards so fetch drops keep-alive sockets the server closed meanwhile
    // (otherwise the next request can fail with ECONNRESET).
    const query = async command => { const rows = sql(command); await new Promise(resolve => setTimeout(resolve, 50)); return rows; };
    const row = async id => (await query(`SELECT requeststatus AS status, version, supplierorderid AS "supplierOrderId" FROM requests WHERE id = '${id}'`))[0];
    const remaining = async department => (await query(`SELECT remaining FROM budgets WHERE department = '${department}'`))[0].remaining;
    const ledgerRows = () => query("SELECT requestid AS \"requestId\", amount, remainingafter AS \"remainingAfter\" FROM ledger");
    const operation = (cookie, name, body) => call("POST", `/admin/api/operations/${name}`, { cookie, body });
    const signed = (payload, secret = SECRET) => {
      const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      return call("POST", "/callbacks/supplier", { body, headers: { "x-supplier-timestamp": timestamp, "x-supplier-signature": signature } });
    };

    const admin = await signIn(owner), alice = await signIn("alice@example.test"), bob = await signIn("bob@example.test");
    const carol = await signIn("carol@example.test");
    await query(`UPDATE "user" SET role = 'admin' WHERE email = 'carol@example.test'`);
    assert.equal((await call("GET", "/admin/api/me", { cookie: carol })).status, 200);

    const submit = async (cookie, title, amount, department) => {
      const response = await call("POST", "/api/requests", { cookie, body: { title, amount, department } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.results[0][0]?.id;
    };
    assert.equal((await call("POST", "/api/requests", { body: { title: "Pens", amount: 5, department: "Design" } })).status, 401);
    const laptop = await submit(alice, "Laptop", 1200, "Engineering");
    const monitors = await submit(alice, "Monitors", 1500, "Design");
    const chairs = await submit(alice, "Chairs", 300, "Design");
    const desk = await submit(bob, "Desk", 400, "Engineering");
    assert.equal(await submit(bob, "Rocket", 10, "Space"), undefined);
    assert.equal((await query("SELECT count(*) AS n FROM requests"))[0].n, 4);
    const mine = (await call("GET", "/api/views/my-requests", { cookie: alice })).body.rows;
    assert.deepEqual(mine.map(r => r.title).sort(), ["Chairs", "Laptop", "Monitors"]);
    assert.deepEqual((await call("GET", "/api/views/my-requests", { cookie: bob })).body.rows.map(r => r.title), ["Desk"]);
    step("employees submit requests (unknown department creates nothing) and see only their own");

    const version = async id => (await row(id)).version;
    assert.equal((await operation(alice, "approve-request", { id: laptop, expectedVersion: await version(laptop) })).status, 403);
    const publicTools = (await mcp("/mcp", alice)).body.result.tools.map(t => t.name);
    assert.ok(!publicTools.includes("approve_request") && !publicTools.includes("reject_request"), publicTools.join());
    const adminTools = (await mcp("/mcp/admin", admin)).body.result.tools.map(t => t.name);
    assert.ok(adminTools.includes("approve_request") && adminTools.includes("reject_request"), adminTools.join());
    for (const hidden of ["confirm_order", "mark_ordered", "approve_request_write", "reject_request_write"])
      assert.ok(!adminTools.includes(hidden) && !publicTools.includes(hidden), hidden);
    step("approve/reject are admin-only: an employee gets 403 in Admin and the tools exist only on /mcp/admin");

    const rejected = await mcp("/mcp/admin", admin, "reject_request", { id: chairs, expectedVersion: await version(chairs) });
    assert.equal(rejected.body.result.isError, undefined, JSON.stringify(rejected.body));
    assert.equal((await row(chairs)).status, "rejected");
    await waitForLog(/purchasing\.rejected → alice@example\.test[\s\S]*?Rejected: Chairs/);
    const guarded = await operation(admin, "approve-request", { id: chairs, expectedVersion: await version(chairs) });
    assert.equal(guarded.status, 409, JSON.stringify(guarded.body));
    assert.equal((await row(chairs)).status, "rejected");
    step("admin MCP rejects (requester emailed); approving it with its current version is 409: WHERE requestStatus = 'submitted' matched 0 rows");

    const overBudget = await operation(admin, "approve-request", { id: monitors, expectedVersion: await version(monitors) });
    assert.equal(overBudget.status, 409, JSON.stringify(overBudget.body));
    assert.match(overBudget.body.error.message, /budget cannot cover/);
    assert.equal((await row(monitors)).status, "submitted");
    assert.equal(await remaining("Design"), 1000);
    assert.equal((await ledgerRows()).length, 0);
    step("over budget: remaining >= 0 fails statement 2, so the status change and ledger insert roll back too");

    // The version a reviewer saw, read the way the client reads it.
    const seen = await version(monitors);
    const edited = await call("PATCH", `/admin/api/entries/${monitors}?collection=requests`, { cookie: carol, body: { expectedVersion: seen, data: { amount: 900 } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const stale = await operation(admin, "approve-request", { id: monitors, expectedVersion: seen });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal((await row(monitors)).status, "submitted");
    assert.equal(await remaining("Design"), 1000);
    step("expectedVersion: after another admin edits the request, approving the version first seen is 409 and changes nothing");

    const lock = (await call("GET", "/api/views/my-requests", { cookie: alice })).body.rows.find(r => r.id === laptop).version;
    const race = await Promise.all([admin, carol].map(cookie => operation(cookie, "approve-request", { id: laptop, expectedVersion: lock })));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409], JSON.stringify(race.map(r => r.body)));
    assert.equal(await remaining("Engineering"), 3800);
    assert.deepEqual(await ledgerRows(), [{ requestId: laptop, amount: 1200, remainingAfter: 3800 }]);
    step("two admins approve the same version at once: one 200, one 409; the budget and ledger change once");

    assert.deepEqual(received, [{ reference: laptop, item: "Laptop", amount: 1200, idempotencyKey: laptop }]);
    assert.deepEqual(await row(laptop), { status: "ordered", version: lock + 2, supplierOrderId: "SUP-1" });
    await waitForLog(/purchasing\.approved → alice@example\.test[\s\S]*?Approved: Laptop/);
    const viaAi = await mcp("/mcp/admin", admin, "approve_request", { id: desk, expectedVersion: await version(desk) });
    assert.equal(viaAi.body.result.isError, undefined, JSON.stringify(viaAi.body));
    assert.equal((await row(desk)).status, "ordered");
    assert.equal(await remaining("Engineering"), 3400);
    await waitForLog(/purchasing\.approved → bob@example\.test[\s\S]*?Approved: Desk/);
    step("approval places the supplier order (status 'ordered') and emails the requester; the admin MCP tool approves too");

    assert.equal((await signed({ reference: laptop, orderId: "SUP-1" }, "wrong-secret")).status, 401);
    const tampered = await call("POST", "/callbacks/supplier", { body: JSON.stringify({ reference: laptop, orderId: "SUP-1" }),
      headers: { "x-supplier-timestamp": String(Math.floor(Date.now() / 1000)), "x-supplier-signature": "0".repeat(64) } });
    assert.equal(tampered.status, 401);
    assert.equal((await row(laptop)).status, "ordered");
    assert.equal((await signed({ reference: laptop, orderId: "SUP-2" })).status, 409);
    assert.equal((await signed({ reference: laptop, orderId: "SUP-1" })).status, 204);
    assert.equal((await row(laptop)).status, "confirmed");
    assert.equal((await signed({ reference: laptop, orderId: "SUP-1" })).status, 409);
    step("supplier callback: bad signatures are 401 with no change; a signed one confirms; a wrong order id or replay is 409");

    const late = await submit(bob, "Whiteboard", 150, "Engineering");
    await query(`UPDATE requests SET created_at = created_at - ${4 * DAY_US} WHERE id = '${late}'`);
    const before = logs().length;
    // smoke-kit's cron() requests /__scheduled, which this wrangler (4.129) no longer serves; this is its current path.
    assert.equal((await fetch(`${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(DAILY)}`)).status, 200);
    for (const to of [owner, "carol@example.test"])
      await waitForLog(new RegExp(`purchasing\\.reminder → ${to.replace(/[.+]/g, "\\$&")}[\\s\\S]*?Whiteboard`));
    const reminder = logs().slice(before);
    assert.ok(!reminder.includes("Monitors"), "a request submitted today is not in the reminder");
    step("daily cron emails every admin about requests pending more than 3 days, and only those");
  });
} finally {
  supplier.close();
  if (saved === undefined) rmSync(".dev.vars", { force: true }); else writeFileSync(".dev.vars", saved);
}
