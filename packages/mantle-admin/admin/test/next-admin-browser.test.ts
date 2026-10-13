import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("native Admin smoke: sign-in shell, list, edit/OCC, publish and translation save", async () => {
  if (!process.env.MANTLE_NEXT_ROOT) throw Error("Set MANTLE_NEXT_ROOT to the canonical packages/mantle path.");
  const child = spawn(process.env.MANTLE_TEST_BUN ?? "bun", [resolve(import.meta.dirname, "next-admin-fixture.mjs")], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const mail = new Map<string, string>();
  let origin = "", articleId = "", translationId = "", stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try { const event = JSON.parse(line); if (event.ready) { origin = event.ready; articleId = event.articleId; translationId = event.translationId; } if (event.email) mail.set(event.email, event.otp); }
    catch { /* dependency startup notices are not fixture events */ }
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await expect.poll(() => { if (child.exitCode !== null) throw Error(stderr); return origin; }, { timeout: 30_000 }).not.toBe("");
    browser = await chromium.launch({ headless: true, channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM });
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
    // A concurrent edit must not let the browser overwrite a version it did not review.
    const entryPath = origin + "/admin/api/entries/" + taskId + "?collection=tasks";
    expect((await context.request.patch(entryPath, {
      headers: { origin }, data: { expectedVersion: 2, data: { title: "Concurrent edit" } },
    })).status()).toBe(200);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Unsaved local edit");
    const conflict = page.waitForResponse(response => response.url() === entryPath && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await conflict).status()).toBe(409);
    expect(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue()).toBe("Unsaved local edit");
    expect((await (await context.request.get(entryPath)).json()).entry.data.title).toBe("Concurrent edit");

    await page.goto(origin + "/admin/c/articles/" + articleId + "/edit");
    const published = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/publish") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    expect((await published).status()).toBe(200);
    await expect.poll(async () => (await (await context.request.get(origin + "/admin/api/entries/" + articleId + "?collection=articles")).json()).entry.status).toBe("published");

    await page.goto(origin + "/admin/c/article-translations/" + translationId + "/edit");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Traduction enregistrée");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => {
      const entry = (await (await context.request.get(origin + "/admin/api/entries/" + translationId + "?collection=article-translations")).json()).entry;
      return { title: entry.data.title, locale: entry.data.locale, version: entry.version };
    }).toEqual({ title: "Traduction enregistrée", locale: "fr", version: 2 });
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
