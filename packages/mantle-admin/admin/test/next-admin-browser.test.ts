import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createOperationController } from "../src/features/content/row-operations";

// Explicit source selection avoids silently testing the legacy Core instead of Next.
const native = process.env.MANTLE_NEXT_ROOT ? it : it.skip;
native("real Next SQLite + Better Auth OTP renders staff data, forward paging and member denial", async () => {
  const child = spawn(process.env.MANTLE_TEST_BUN ?? "bun", [resolve(import.meta.dirname, "next-admin-fixture.mjs")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const mail = new Map<string, string>();
  let origin = "", stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try { const event = JSON.parse(line); if (event.ready) origin = event.ready; if (event.email) mail.set(event.email, event.otp); }
    catch { /* dependency startup notices are not fixture events */ }
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await expect.poll(() => { if (child.exitCode !== null) throw Error(stderr); return origin; }, { timeout: 30_000 }).not.toBe("");
    browser = await chromium.launch({ headless: true, executablePath: process.env.MANTLE_TEST_CHROMIUM });
    const context = await browser.newContext({ locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
    const page = await context.newPage(), errors: string[] = [], entryRequests: URL[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname === "/admin/api/entries") entryRequests.push(url); });
    const login = async (email: string, returnTo: string) => {
      mail.delete(email);
      await page.goto(origin + "/admin/sign-in?return=" + encodeURIComponent(returnTo));
      await page.getByRole("textbox", { name: "Email address" }).fill(email);
      await page.getByRole("button", { name: "Send code" }).click();
      await expect.poll(() => mail.get(email)).toBeTruthy();
      const verification = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/sign-in/email-otp" && response.request().method() === "POST");
      await page.getByRole("textbox", { name: "One-time code" }).fill(mail.get(email)!);
      expect((await verification).status()).toBe(200);
      await expect.poll(() => new URL(page.url()).pathname).toBe(returnTo);
    };
    await login("staff@example.test", "/admin/c/tasks");
    await expect.poll(() => page.locator("tbody tr").count()).toBe(50);
    const first = await page.locator("tbody tr").first().innerText();
    expect(await page.locator("tbody").innerText()).not.toMatch(/draft|published|archived/i);
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.getAll("cursor").length).toBe(1);
    await expect.poll(() => page.locator("tbody tr").first().innerText()).not.toBe(first);
    const second = await page.locator("tbody tr").first().innerText();
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await expect.poll(() => page.locator("tbody tr").count()).toBe(5);
    expect(new URL(page.url()).searchParams.getAll("cursor")).toHaveLength(2);
    await page.getByRole("link", { name: "Previous", exact: true }).click();
    await expect.poll(() => page.locator("tbody tr").first().innerText()).toBe(second);
    expect(new URL(page.url()).searchParams.getAll("cursor")).toHaveLength(1);
    expect(entryRequests.every(url => !url.searchParams.has("cursor_direction"))).toBe(true);
    const taskPage = await (await context.request.get(origin + "/admin/api/entries?collection=tasks")).json();
    const taskId = taskPage.items[0].id;
    await page.goto(origin + "/admin/c/tasks/" + taskId + "/edit");
    await page.getByRole("button", { name: "Unlock editing" }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Edited native Task");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => {
      const payload = await (await context.request.get(origin + "/admin/api/entries/" + taskId + "?collection=tasks")).json();
      return { title: payload.entry.data.title, version: payload.entry.version };
    }).toEqual({ title: "Edited native Task", version: 2 });
    const refused = await context.request.patch(origin + "/admin/api/entries/" + taskId + "?collection=tasks", {
      headers: { origin: "https://another-origin.test" }, data: { expectedVersion: 2, data: { title: "Must not be saved" } },
    });
    expect(refused.status()).toBe(403);
    const operationList = await (await context.request.get(origin + "/admin/api/operations")).json();
    const operation = operationList.operations.find((item: {name: string}) => item.name === "add-task");
    expect(operation).toBeTruthy();
    const originalFetch = globalThis.fetch;
    const cookies = (await context.cookies()).map(cookie => cookie.name + "=" + cookie.value).join("; ");
    let writes = 0;
    // Resolve the browser-relative client in Node while retaining real HTTP, cookies and native SQL.
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "POST") writes++;
      const headers = new Headers(init?.headers); headers.set("cookie", cookies); headers.set("origin", origin);
      return originalFetch(new URL(String(input), origin), { ...init, headers });
    }) as typeof fetch;
    try {
      const invalid = createOperationController(operation, undefined, undefined, undefined);
      await invalid.open(); invalid.edit("title", 123); await invalid.submit();
      expect(invalid.getSnapshot()).toMatchObject({ phase: "failed", diagnostics: [{code: "INPUT_VALIDATION_FAILED"}] });
      expect(writes).toBe(1);
      const locked = createOperationController(operation, {collection: "tasks", bind: [{input: "id", field: "id"}], version: "expectedVersion", mutates: true}, "tasks", {id: taskId, version: 2});
      await locked.open(); locked.edit("title", "Edited native Task"); await locked.submit();
      expect(locked.getSnapshot()).toMatchObject({ phase: "conflict", draft: {title: "Edited native Task"}, diagnostics: [{code: "CONFLICT"}] });
      expect(writes).toBe(2);
      const uncertain = createOperationController(operationList.operations.find((item: {name: string}) => item.name === "uncertain-task"), undefined, undefined, undefined);
      await uncertain.open(); uncertain.edit("title", "Uncertain native write"); await uncertain.submit();
      expect(uncertain.getSnapshot()).toMatchObject({ phase: "uncertain", draft: {title: "Uncertain native write"}, diagnostics: [{code: "OUTCOME_UNKNOWN"}] });
      expect(writes).toBe(3); // no implicit retry after the committed write returned 503
    } finally { globalThis.fetch = originalFetch; }

    expect((await context.request.get(origin + "/admin/api/media")).status()).toBe(501);
    expect((await context.request.get(origin + "/admin/api/site-settings")).status()).toBe(501);
    await page.goto(origin + "/admin/members");
    await expect.poll(() => page.locator("tbody").innerText()).toContain("user@example.test");
    await page.goto(origin + "/admin/staff");
    await expect.poll(() => page.locator("tbody").innerText()).toContain("staff@example.test");
    expect(await page.locator("body").innerText()).toContain("@aotter/mantle@");
    expect(errors).toEqual([]);
    await context.clearCookies();
    await login("user@example.test", "/admin/c/tasks");
    expect((await context.request.get(origin + "/admin/api/entries?collection=tasks")).status()).toBe(403);
    await expect.poll(() => page.locator("body").innerText()).toMatch(/access denied/i);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); lines.close();
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  }
}, 120_000);
