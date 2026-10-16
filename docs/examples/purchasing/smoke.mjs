// Purchase requests end to end: submit, guarded transitions, admin-only approve/reject (Admin + admin MCP),
// optimistic concurrency, one-transaction approval with a budget check, supplier order + signed callback, emails, cron.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { assertMcpDiscovery, smoke } from "./smoke-kit.mjs";
import { developerConsole } from "./generated/admin-descriptors.ts";

const SECRET = "local-supplier-secret", DAILY = "0 9 * * *", DAY_US = 86_400 * 1_000_000;

// A stand-in supplier API: accepts an order and answers with its order id, or 503 while `supplierDown`.
const received = [];
let supplierDown = false;
const supplier = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (supplierDown) return response.writeHead(503).end();
    received.push({ ...JSON.parse(body), idempotencyKey: request.headers["idempotency-key"] });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ orderId: `SUP-${received.length}` }));
  });
});
await new Promise(resolve => supplier.listen(0, "127.0.0.1", resolve));

try {
  await smoke(async ({ origin, owner, call, mcp, signIn, sql, cron, waitForLog, step, logs }) => {
    const query = sql;
    const row = async id => (await query(`SELECT requeststatus AS status, version, supplierorderid AS "supplierOrderId" FROM requests WHERE id = '${id}'`))[0];
    const statusAndOrder = async id => { const { status, supplierOrderId } = await row(id); return { status, supplierOrderId }; };
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
    const projector = await submit(bob, "Projector", 600, "Engineering");
    assert.equal(await submit(bob, "Rocket", 10, "Space"), undefined);
    assert.equal((await query("SELECT count(*) AS n FROM requests"))[0].n, 5);
    const mine = (await call("GET", "/api/views/my-requests", { cookie: alice })).body.rows;
    assert.deepEqual(mine.map(r => r.title).sort(), ["Chairs", "Laptop", "Monitors"]);
    assert.deepEqual((await call("GET", "/api/views/my-requests", { cookie: bob })).body.rows.map(r => r.title).sort(), ["Desk", "Projector"]);
    step("employees submit requests (unknown department creates nothing) and see only their own");

    // fetch follows the 303, so an anonymous visitor ends on the sign-in page.
    assert.match((await call("GET", "/requests")).body, /<h1>Sign in<\/h1>/);
    assert.match((await call("GET", "/sign-in?return=%2Frequests")).body, /sign-in\/email-otp/);
    const page = (await call("GET", "/requests", { cookie: bob })).body;
    assert.match(page, /Projector/); assert.doesNotMatch(page, /Laptop/); assert.match(page, /<option>Design<\/option>/);
    // Writes go through the REST Trigger the page's form names, never through the page itself.
    assert.match(page, /<form action="\/api\/requests" method="post"/);
    assert.equal((await call("POST", "/requests", { cookie: bob })).status, 404);
    assert.equal((await call("POST", "/api/requests", { cookie: bob, body: { title: "Pens", amount: 0, department: "Design" } })).status, 400);
    step("the /requests page sends anonymous visitors to /sign-in, lists only the employee's own requests and submits to the REST Trigger");

    assert.equal((await operation(admin, "open-budget", { department: "Marketing", remaining: 500 })).status, 200);
    assert.equal((await operation(admin, "open-budget", { department: "Design", remaining: 1 })).status, 409);
    assert.equal(await remaining("Marketing"), 500);
    assert.equal((await operation(alice, "open-budget", { department: "Ops", remaining: 1 })).status, 403);
    step("admins open a department budget from the Budgets list header (open-budget; a second one for the same department is 409); employees cannot");

    const version = async id => (await row(id)).version;
    assert.equal((await operation(alice, "approve-request", { id: laptop, expectedVersion: await version(laptop) })).status, 403);
    // Generated static metadata uses the MCP tool names; the app chooses the surface and test identity.
    const declared = developerConsole.interfaces.callable;
    const publicTools = await assertMcpDiscovery(`${origin}/mcp`, { headers: { cookie: alice, origin }, tools: declared.filter(tool => tool.surface === "public") });
    assert.ok(!publicTools.includes("approve_request") && !publicTools.includes("reject_request"), publicTools.join());
    const adminTools = await assertMcpDiscovery(`${origin}/mcp/admin`, { headers: { cookie: admin, origin }, tools: declared.filter(tool => tool.surface === "admin") });
    // Denial is separate from successful initialized discovery.
    assert.equal((await mcp("/mcp/admin")).status, 401);
    assert.equal((await mcp("/mcp/admin", alice)).status, 403);
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

    const seen = await version(monitors); // the version the admin reviewed
    const generic = await call("PATCH", `/admin/api/entries/${monitors}?collection=requests`, { cookie: admin, body: { expectedVersion: seen, data: { requestStatus: "approved" } } });
    assert.ok(generic.status >= 400 && generic.status < 500, JSON.stringify(generic.body));
    assert.deepEqual([(await row(monitors)).status, await version(monitors)], ["submitted", seen]);
    const changeAmount = (cookie, expectedVersion) => call("POST", `/api/requests/${monitors}/amount`, { cookie, body: { expectedVersion, amount: 900 } });
    assert.equal((await changeAmount(bob, seen)).status, 409);
    const changed = await changeAmount(alice, seen);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await changeAmount(alice, seen)).status, 409);
    const stale = await operation(admin, "approve-request", { id: monitors, expectedVersion: seen });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal((await row(monitors)).status, "submitted");
    assert.equal(await remaining("Design"), 1000);
    step("Admin cannot edit requests generically; once the requester changes the amount, approving the reviewed version is 409");

    const lock = (await call("GET", "/api/views/my-requests", { cookie: alice })).body.rows.find(r => r.id === laptop).version;
    const race = await Promise.all([admin, carol].map(cookie => operation(cookie, "approve-request", { id: laptop, expectedVersion: lock })));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409], JSON.stringify(race.map(r => r.body)));
    assert.equal(await remaining("Engineering"), 3800);
    assert.deepEqual(await ledgerRows(), [{ requestId: laptop, amount: 1200, remainingAfter: 3800 }]);
    step("two admins approve the same version at once: one 200, one 409; the budget and ledger change once");

    assert.deepEqual(received, [{ reference: laptop, item: "Laptop", amount: 1200, idempotencyKey: laptop }]);
    assert.deepEqual(await row(laptop), { status: "ordered", version: lock + 2, supplierOrderId: "SUP-1" });
    await waitForLog(/purchasing\.approved → alice@example\.test[\s\S]*?Approved: Laptop/);
    step("approval places the supplier order (status 'ordered') and emails the requester");

    supplierDown = true;
    const viaAi = await mcp("/mcp/admin", admin, "approve_request", { id: desk, expectedVersion: await version(desk) });
    assert.equal(viaAi.body.result.isError, undefined, JSON.stringify(viaAi.body));
    assert.equal((await operation(carol, "approve-request", { id: projector, expectedVersion: await version(projector) })).status, 200);
    assert.deepEqual([(await row(desk)).status, (await row(projector)).status], ["approved", "approved"]);
    assert.equal(await remaining("Engineering"), 2800);
    await waitForLog(/purchasing\.approved → bob@example\.test[\s\S]*?Approved: Desk/);
    step("the admin MCP tool approves too; with the supplier down, approvals still commit and stay 'approved'");

    assert.equal((await signed({ reference: laptop, orderId: "SUP-1" }, "wrong-secret")).status, 401);
    const tampered = await call("POST", "/callbacks/supplier", { body: JSON.stringify({ reference: laptop, orderId: "SUP-1" }),
      headers: { "x-supplier-timestamp": String(Math.floor(Date.now() / 1000)), "x-supplier-signature": "0".repeat(64) } });
    assert.equal(tampered.status, 401);
    assert.equal((await row(laptop)).status, "ordered");
    assert.equal((await signed({ reference: laptop, orderId: "SUP-9" })).status, 409);
    assert.equal((await signed({ reference: laptop, orderId: "SUP-1" })).status, 204);
    assert.equal((await row(laptop)).status, "confirmed");
    assert.equal((await signed({ reference: laptop, orderId: "SUP-1" })).status, 204);
    assert.equal((await signed({ reference: monitors, orderId: "SUP-1" })).status, 409);
    // The callback can beat mark-ordered: an 'approved' request is confirmed and keeps the supplier's order id.
    assert.equal((await signed({ reference: desk, orderId: "SUP-EARLY" })).status, 204);
    assert.deepEqual(await statusAndOrder(desk), { status: "confirmed", supplierOrderId: "SUP-EARLY" });
    step("supplier callback: bad signatures are 401 with no change; a signed one confirms (also before 'ordered'); a replay is 204; a wrong order id or a submitted request is 409");

    const late = await submit(bob, "Whiteboard", 150, "Engineering");
    await query(`UPDATE requests SET created_at = created_at - ${4 * DAY_US} WHERE id = '${late}'`);
    const before = logs().length;
    supplierDown = false;
    assert.equal(await cron(DAILY), 200);
    for (const to of [owner, "carol@example.test"])
      await waitForLog(new RegExp(`purchasing\\.reminder → ${to.replace(/[.+]/g, "\\$&")}[\\s\\S]*?Whiteboard`));
    const reminder = logs().slice(before);
    assert.ok(!reminder.includes("Monitors"), "a request submitted today is not in the reminder");
    assert.deepEqual(received.map(order => order.reference), [laptop, projector]);
    assert.deepEqual(await statusAndOrder(projector), { status: "ordered", supplierOrderId: "SUP-2" });
    step("daily cron retries the failed supplier order (system caller) and emails every admin about requests pending more than 3 days, and only those");
  }, { vars: { EMPLOYEE_DOMAIN: "example.test", SUPPLIER_API_URL: `http://127.0.0.1:${supplier.address().port}/orders`, SUPPLIER_WEBHOOK_SECRET: SECRET } });
} finally {
  supplier.close();
}
