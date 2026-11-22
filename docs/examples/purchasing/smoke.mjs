// Purchase requests end to end: submit, guarded transitions, admin-only approve/reject (Admin + admin MCP),
// optimistic concurrency, one-transaction approval with a budget check, supplier order + signed callback, emails, cron,
// and the employees' single-page app under /app: its shell document, its REST calls, and one short run in Chrome.
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

    // The employees' app under /app: one static shell document for every page, the same bytes for everyone.
    const deep = `/app/requests/${laptop}?tab=1`;
    const away = await fetch(`${origin}${deep}`, { redirect: "manual" });
    assert.equal(away.status, 303);
    assert.equal(away.headers.get("location"), `/sign-in?return=${encodeURIComponent(deep)}`);
    assert.equal(away.headers.get("cache-control"), "no-store");
    // fetch follows the 303: what a signed-out crawler can fetch is the sign-in page, with no workflow data.
    const anonymous = await call("GET", "/app");
    assert.match(anonymous.body, /<h1>Sign in<\/h1>/);
    for (const title of ["Laptop", "Monitors", "Engineering"]) assert.ok(!anonymous.body.includes(title), title);
    // The sign-in page goes back only to a path on this origin.
    assert.ok(anonymous.body.includes("new URL(back, location.origin).origin === location.origin"));
    const shell = await call("GET", "/app", { cookie: alice });
    for (const path of ["/app", "/app/", "/app/new", `/app/requests/${laptop}`]) {
      const response = await call("GET", path, { cookie: path === "/app/new" ? bob : alice });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type"), /^text\/html/);
      assert.equal(response.headers.get("x-robots-tag"), "noindex", path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      assert.equal(response.body, shell.body, `${path}: the same document for every page and every employee`);
    }
    assert.ok(shell.body.includes(`<meta name="robots" content="noindex">`) && shell.body.includes(`<div id="root"></div>`));
    for (const title of ["Laptop", "Monitors", "Projector", "Engineering"]) assert.ok(!shell.body.includes(title), `the shell holds no workflow data (${title})`);
    const scripts = [...shell.body.matchAll(/<script\b([^>]*)>/g)].map(([, attributes]) => attributes.trim());
    assert.deepEqual(scripts, [`type="module" src="/assets/client/app.js"`], "one module script and no inline script");
    assert.ok(shell.body.includes(`<link rel="stylesheet" href="/assets/client/app.css">`));
    // Paths under /app the app does not have: the same document (the app shows its not-found page) with a real 404.
    for (const path of ["/app/nope", "/app/index.html", "/app/requests/a/b", "/app/new/"]) {
      const missing = await call("GET", path, { cookie: alice });
      assert.equal(missing.status, 404, path);
      assert.equal(missing.body, shell.body, path);
      assert.equal(missing.headers.get("cache-control"), "no-store", path);
    }
    // Outside the prefix there is no single-page fallback: unknown URLs, including the old page, are the Worker's 404.
    for (const path of ["/nope", "/application", "/app.js", "/requests", "/apps/x"]) {
      const missing = await call("GET", path, { cookie: alice });
      assert.equal(missing.status, 404, path);
      assert.equal(missing.body, "Not found", path);
      assert.equal(missing.headers.get("cache-control"), "no-store", path);
    }
    assert.equal((await call("POST", "/app", { cookie: alice })).status, 405);
    // Never listed for crawlers, and never disallowed: a disallowed page's noindex is never read.
    for (const path of ["/robots.txt", "/sitemap.xml", "/llms.txt"]) assert.ok(!String((await call("GET", path)).body).includes("/app"), path);
    // /assets/* is served by the edge without the Worker: plain fetch, as the kit's `call` asserts the Worker's own Cache-Control.
    const bundle = await fetch(`${origin}/assets/client/app.js`), stylesheet = await fetch(`${origin}/assets/client/app.css`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get("content-type"), /javascript/);
    assert.match(await stylesheet.text(), /--radius/, "app.css carries the kit's kit.css");
    step("/app: anonymous visitors go to /sign-in and back; employees get one noindex, no-store shell with no data; unknown paths are 404 inside and outside /app");

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

    const rejectionVersion = await version(chairs);
    for (const reason of [undefined, "   "]) {
      const refused = await mcp("/mcp/admin", admin, "reject_request", { id: chairs, expectedVersion: rejectionVersion, ...(reason === undefined ? {} : { reason }) });
      assert.equal(refused.body.result.isError, true, JSON.stringify(refused.body));
      assert.equal((await row(chairs)).status, "submitted");
      assert.equal(await version(chairs), rejectionVersion);
    }
    const rejectionReason = "The department is deferring this purchase.";
    const rejected = await mcp("/mcp/admin", admin, "reject_request", { id: chairs, expectedVersion: rejectionVersion, reason: rejectionReason });
    assert.equal(rejected.body.result.isError, undefined, JSON.stringify(rejected.body));
    assert.equal((await row(chairs)).status, "rejected");
    assert.equal((await query(`SELECT rejectionReason AS reason FROM requests WHERE id = '${chairs}'`))[0].reason, rejectionReason);
    await waitForLog(/purchasing\.rejected → alice@example\.test[\s\S]*?Rejected: Chairs/);
    await waitForLog(/The department is deferring this purchase\./);
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
    // src/routes.ts answers a bare Response; the shell's src/service.ts states Cache-Control for it.
    assert.equal(tampered.headers.get("cache-control"), "private, no-store");
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

    const small = await call("POST", "/api/requests", { cookie: bob, body: { title: "Pens", amount: 50, department: "Engineering" } });
    assert.equal(small.status, 200, JSON.stringify(small.body));
    const pens = small.body.results[0][0];
    assert.equal(pens.requestStatus, "approved");
    const spent = await remaining("Engineering");
    assert.deepEqual((await ledgerRows()).filter(r => r.requestId === pens.id), [{ requestId: pens.id, amount: 50, remainingAfter: spent }]);
    await query(`UPDATE budgets SET remaining = 20 WHERE department = 'Design'`);
    const ledgerBefore = (await ledgerRows()).length, requestsBefore = (await query("SELECT count(*) AS n FROM requests"))[0].n;
    assert.equal((await call("POST", "/api/requests", { cookie: alice, body: { title: "Tape", amount: 30, department: "Design" } })).status, 409);
    assert.equal(await remaining("Design"), 20);
    assert.equal((await ledgerRows()).length, ledgerBefore);
    assert.equal((await query("SELECT count(*) AS n FROM requests"))[0].n, requestsBefore);
    step("CASE approves a request of 100 or less at submission: the status, the budget and the ledger row commit together, and one that would overspend is refused with nothing written");
    const engineeringBudget = (await query("SELECT id FROM budgets WHERE department = 'Engineering'"))[0].id;
    assert.equal((await query(`SELECT budgetid FROM requests WHERE id = '${laptop}'`))[0].budgetid, engineeringBudget);
    assert.equal((await query(`SELECT budgetid FROM ledger WHERE requestid = '${pens.id}'`))[0].budgetid, engineeringBudget);
    assert.equal((await query("SELECT COUNT(*) AS n FROM ledger l JOIN requests r ON r.id = l.requestid WHERE l.budgetid <> r.budgetid"))[0].n, 0);
    step("requests and ledger rows reference the same stable budget, with at most one ledger row per request");

    // The app's calls, end to end: it reads the Views and writes only through the REST Triggers.
    const dana = await signIn("dana@example.test");
    const budgets = (await call("GET", "/api/views/department-budgets", { cookie: dana })).body.rows;
    assert.deepEqual(budgets.find(b => b.department === "Marketing"), { department: "Marketing", remaining: 500 });
    assert.equal((await call("GET", "/api/views/department-budgets")).status, 401);
    const invalid = await call("POST", "/api/requests", { cookie: dana, body: { title: "Banner", amount: 0, department: "Marketing" } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error.path, /amount/, "the app shows a refused field beside it");
    const banner = await submit(dana, "Banner", 300, "Marketing");
    const danaRows = async () => (await call("GET", "/api/views/my-requests", { cookie: dana })).body.rows;
    assert.deepEqual((await danaRows()).map(r => [r.title, r.requestStatus]), [["Banner", "submitted"]]);
    const detail = async cookie => call("GET", `/api/views/my-request?id=${banner}`, { cookie });
    const shown = (await detail(dana)).body.rows[0];
    assert.equal(shown.requestStatus, "submitted");
    assert.deepEqual((await detail(alice)).body.rows, [], "another employee cannot read it");
    assert.equal((await detail()).status, 401);
    for (const path of ["/api/views/my-requests", `/api/views/my-request?id=${banner}`, "/api/views/department-budgets"])
      assert.equal((await call("GET", path, { cookie: dana })).headers.get("cache-control"), "private, no-store", path);
    assert.equal((await operation(admin, "approve-request", { id: banner, expectedVersion: shown.version })).status, 200);
    assert.deepEqual((await danaRows()).map(r => [r.title, r.requestStatus]), [["Banner", "ordered"]]);
    assert.deepEqual([(await detail(dana)).body.rows[0].requestStatus, (await detail(dana)).body.rows[0].supplierOrderId], ["ordered", "SUP-3"]);
    assert.equal((await call("GET", "/api/views/department-budgets", { cookie: dana })).body.rows.find(b => b.department === "Marketing").remaining, 200);
    step("the app's REST calls: an employee submits, sees it submitted, an admin approves, the employee sees it ordered and the budget's new remainder");

    // One short run of the UI in Chrome (the same browser the Admin MCP App test uses): Dana's session, the form's inline
    // errors, a submit through the UI, and the new request in the list. It runs when MANTLE_TEST_CHROMIUM names a Chrome;
    // the repository's Full checks set it.
    if (!process.env.MANTLE_TEST_CHROMIUM) step("skipped the /app run in Chrome: set MANTLE_TEST_CHROMIUM to a Chrome or Chromium binary");
    else {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ headless: true, executablePath: process.env.MANTLE_TEST_CHROMIUM });
      try {
        const signedOut = await browser.newPage();
        await signedOut.goto(`${origin}/app/new`);
        assert.equal(new URL(signedOut.url()).pathname + new URL(signedOut.url()).search, "/sign-in?return=%2Fapp%2Fnew");
        const context = await browser.newContext();
        await context.addCookies(dana.split("; ").map(pair => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: origin })));
        const page = await context.newPage();
        const failures = [];
        page.on("pageerror", error => failures.push(error.message));
        await page.goto(`${origin}/app/new`);
        await page.getByRole("button", { name: "Submit" }).click();
        await page.getByText("Say what you need.").waitFor();
        await page.getByLabel("What").fill("Easel");
        await page.getByLabel("Department").selectOption("Marketing");
        await page.getByLabel("Amount").fill("80");
        await page.getByRole("button", { name: "Submit" }).click();
        await page.waitForURL(/\/app\/requests\/[\w-]+$/);
        await page.getByRole("heading", { name: "Easel" }).waitFor();
        await page.getByRole("link", { name: "My requests" }).click();
        await page.getByRole("link", { name: "Easel" }).waitFor();
        assert.deepEqual(failures, []);
        await page.goto(`${origin}/app/nope`);
        await page.getByRole("heading", { name: "Not found" }).waitFor();
      } finally {
        await browser.close();
      }
      assert.deepEqual((await danaRows()).map(r => [r.title, r.requestStatus]), [["Easel", "approved"], ["Banner", "ordered"]]);
      step("in Chrome: /app sends a signed-out visitor to sign in; signed in, the form shows its errors inline, submits, and the list shows the new request");
    }
  }, { vars: { EMPLOYEE_DOMAIN: "example.test", SUPPLIER_API_URL: `http://127.0.0.1:${supplier.address().port}/orders`, SUPPLIER_WEBHOOK_SECRET: SECRET } });
} finally {
  supplier.close();
}
