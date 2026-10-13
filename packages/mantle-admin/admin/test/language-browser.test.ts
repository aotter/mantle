import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it.each([false, true])("preloads one language snapshot, survives cross-tab race=%s and switches atomically", async crossTab => {
  const dist = resolve(import.meta.dirname, "../../dist/admin");
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const requested: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let releaseFirst!: () => void, releaseNext!: () => void, firstRequested!: () => void, nextRequested!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const next = new Promise<void>(resolve => { releaseNext = resolve; });
    const waitingFirst = new Promise<void>(resolve => { firstRequested = resolve; });
    const waitingNext = new Promise<void>(resolve => { nextRequested = resolve; });
    await page.addInitScript(() => localStorage.setItem("cms.preference.language", "zh-TW"));
    await page.route("http://language.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      requested.push(path);
      if (/\/zh-TW-[^/]+\.js$/.test(path)) { firstRequested(); await first; }
      if (/\/ja-[^/]+\.js$/.test(path)) { nextRequested(); await next; }
      if (path.startsWith("/admin/api/")) {
        const body = path.endsWith("/me") ? { role: "staff", login: "fixture", image: null }
          : path.endsWith("/site") ? { brand: "Fixture", locales: ["en"], canonicalLocale: "en", extensions: [] }
          : path.endsWith("/collections") ? { collections: [], allCollections: {} }
          : path.endsWith("/operations") ? { operations: [] }
          : path.endsWith("/views-manifest") ? { views: [] } : { tools: [], routes: {} };
        return route.fulfill({ json: body });
      }
      const file = resolve(dist, path.replace(/^\/admin\//, ""));
      const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
      return route.fulfill({ body: readFileSync(file.startsWith(dist) && existsSync(file) ? file : resolve(dist, "index.html")), contentType: types[extname(file)] ?? "text/html" });
    });
    await page.goto("http://language.test/admin/preferences", { waitUntil: "commit" });
    await expect.poll(() => ({requested, errors})).toMatchObject({requested: expect.arrayContaining([expect.stringMatching(/zh-TW-.*js$/)]), errors: []});
    await waitingFirst;
    expect(await page.evaluate(() => document.getElementById("root")?.textContent)).toBe("");
    if (crossTab) {
      const otherTab = await context.newPage();
      await otherTab.route("http://language.test/storage", route => route.fulfill({body:"", contentType:"text/html"}));
      await otherTab.goto("http://language.test/storage");
      await otherTab.evaluate(() => localStorage.setItem("cms.preference.language", "ja"));
      await otherTab.close();
    }
    releaseFirst();
    await page.getByRole("heading", { name: "個人偏好", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-Hant-TW");
    expect(requested.filter(path => /\/(?:de|es|fr|it|ja|ko|pt-BR|ru|zh-CN|id|nl|pl|tr|vi|cs|uk|ar|he|fa|th)-[^/]+\.js$/.test(path))).toEqual([]);
    await page.getByRole("button", { name: "後台語言", exact: true }).first().click();
    expect(await page.getByRole("menuitem").count()).toBe(22);
    await page.getByRole("menuitem", { name: "日本語", exact: true }).click();
    await waitingNext;
    expect(await page.locator("h1").textContent()).toBe("個人偏好");
    expect(await page.evaluate(() => localStorage.getItem("cms.preference.language"))).toBe(crossTab ? "ja" : "zh-TW");
    releaseNext();
    await page.getByRole("heading", { name: "個人設定", exact: true }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("cms.preference.language"))).toBe("ja");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("ja");
    expect(requested.some(path => /(?:html-editor|markdown-editor|developer-workspace)/.test(path))).toBe(false);
  } finally { await browser.close(); }
}, 30_000);
