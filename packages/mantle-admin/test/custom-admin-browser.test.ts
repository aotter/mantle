import { expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

// The same entry/CSS as mcp-app-browser.test.ts, mounted by the real public MantleAdmin root.
// API fixtures test UI composition, not server authorization (covered by Core acceptance).
it("the app's both cell, CSS and useView page work in browser Admin as in the MCP host", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-custom-admin-"));
  const { buildAdmin } = await import("../dist/build/index.js");
  const dist = join(root, "admin");
  await buildAdmin({ entry: resolve(import.meta.dirname, "fixtures/admin.tsx"), outDir: dist });
  const requests: string[] = [];
  const views = ["pending", "queue"].map(name => ({ name, title: null, description: null, input: null, list: { columns: ["item"], searchFields: [], filterFields: [] }, columns: { item: { type: "string" } } }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname.startsWith("/admin/api/")) {
      requests.push(url.pathname + url.search);
      const fixed: Record<string, unknown> = {
        "/admin/api/me": { role: "admin", admin: true, developer: true, login: "fixture", image: null },
        "/admin/api/site": { brand: "Fixture", icons: [], locales: ["en"], canonicalLocale: "en" },
        "/admin/api/collections": { collections: [], allCollections: {} },
        "/admin/api/operations": { operations: [] }, "/admin/api/views-manifest": { views },
        "/admin/api/webmcp": { tools: [], routes: {} },
        "/admin/api/views/pending": { rows: [{ id: "p1", item: "Laptops" }] },
      };
      const data = url.pathname === "/admin/api/views/queue" ? url.searchParams.has("cursor") ? { rows: [{ id: "q2", item: "second" }] } : { rows: [{ id: "q1", item: "first" }], nextCursor: "q2" } : fixed[url.pathname] ?? {};
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(data)); return;
    }
    try {
      const path = url.pathname.slice("/admin/".length);
      if (/^[\w/-]+\.(?:js|css|svg)$/.test(path)) {
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "image/svg+xml");
        response.end(await readFile(resolve(dist, path))); return;
      }
      response.setHeader("content-type", "text/html"); response.end(await readFile(join(dist, "index.html")));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const page = await browser.newPage(); page.setDefaultTimeout(15_000);
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "en"));
    await page.goto(origin + "/admin/views/pending");
    const cell = page.locator("mark"); await cell.waitFor();
    expect(await cell.getAttribute("data-surface")).toBe("browser");
    expect(await cell.innerText()).toBe("Laptops");
    expect(await cell.evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(254, 220, 186)");
    await page.goto(origin + "/admin/p/queue");
    await page.getByText("page:first").waitFor();
    expect(await page.getByRole("heading", { name: "queue-page" }).locator("..").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(192, 255, 238)");
    await page.getByRole("button", { name: "More queue" }).click();
    await page.getByText("page:second").waitFor();
    expect(await page.getByText("page:first").count()).toBe(1);
    expect(requests.filter(path => path.startsWith("/admin/api/views/queue")).map(path => new URL(path, origin).searchParams.get("cursor"))).toEqual([null, "q2"]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 120_000);
