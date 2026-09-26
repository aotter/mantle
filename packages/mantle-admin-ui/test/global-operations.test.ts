import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";

it("discovers global operations, never retries an uncertain write and reuses its idempotency key", async () => {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    await page.addInitScript(() => { localStorage.setItem("cms.preference.language", "en"); history.replaceState(null, "", "/admin"); });
    const bodies: unknown[] = [];
    await page.route("**/admin/api/**", async route => {
      const path = new URL(route.request().url()).pathname.replace("/admin/api", "");
      const data = path === "/me" ? { id: "owner", role: "owner", login: "owner", image: null }
        : path === "/site" ? { brand: "Empty site", icons: [], canonicalLocale: "en" }
        : path === "/collections" ? { collections: [] }
        : path === "/views-manifest" ? { views: [] }
        : path === "/operations" ? { operations: [{ name: "inspect", title: "Inspect tenant", rowBindings: [], interactions: [], input: { type: "object", required: ["tenantId", "operationId"], properties: { tenantId: { type: "string", title: "Tenant ID" }, operationId: { type: "string", "x-mcp-hint": "idempotency-key" } } } }] }
        : {};
      if (path === "/operations/inspect") {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({ status: bodies.length === 1 ? 503 : 200, json: bodies.length === 1
          ? { error: "temporary_failure", message: "Retry this operation" }
          : { ok: true, output: { tenant: "tenant-1", usage: 4096 } } });
      }
      return route.fulfill({ json: data });
    });
    await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);
    await page.getByRole("link", { name: "Operations", exact: true }).click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("tenant-1");
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    // A 503 without a diagnostic may or may not have run: it is not retried.
    await dialog.getByText("We could not confirm whether this was saved.", { exact: false }).waitFor();
    expect(await dialog.getByRole("textbox").inputValue()).toBe("tenant-1");
    expect(await dialog.getByRole("button", { name: "Run", exact: true }).isEnabled()).toBe(false);
    expect(bodies).toHaveLength(1);
    // Nothing to re-read here: the person checks, then runs it again with the same key.
    await dialog.getByRole("button", { name: "I checked; continue" }).click();
    await dialog.getByRole("button", { name: "Run", exact: true }).click();
    await dialog.getByRole("region", { name: "Result" }).waitFor();
    expect(await dialog.locator("pre").textContent()).toContain('"usage": 4096');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({ tenantId: "tenant-1", operationId: expect.any(String) });
    // A finished operation offers Close, not a second run.
    expect(await dialog.getByRole("button", { name: "Run", exact: true }).count()).toBe(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    await dialog.waitFor({ state: "hidden" });
  } finally { await browser.close(); await server.close(); }
}, 30_000);
