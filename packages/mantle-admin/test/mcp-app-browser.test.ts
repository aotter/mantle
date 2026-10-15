import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const catalog = {
  views: { pending: { columns: { item: { type: "string" }, date: { type: "string", format: "date-time", title: "When" }, link: { type: "string", format: "uri", title: "Link" } }, list: { columns: ["item", "date", "link"] }, actions: ["review_requisition"] } },
  actions: { review_requisition: { capability: "review_requisition", title: "Review", inputSchema: { type: "object", properties: { id: { type: "string" }, expectedVersion: { type: "number" }, date: { type: "string", format: "date-time", title: "Date" } } }, bind: [{ input: "id", field: "id" }], version: "expectedVersion", mutates: true } },
};

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
const serveApp = async (page: import("playwright").Page) => {
  const { mantleAppHtml } = await import("../dist/mcp-app/index.js");
  await page.route("**/src/mcp-app/interaction.html", async route => {
    await route.fulfill({ contentType: "text/html", body: mantleAppHtml.replace('<div id="root">', `<script type="application/json" id="mantle-catalog">${JSON.stringify(catalog)}</script><div id="root">`) });
  });
};

it("interoperates with the official ext-apps AppBridge: context, results, native dates and server tools", async () => {
  const server = await createServer({ configFile: resolve(import.meta.dirname, "../vite.mcp-app.config.ts"), root: resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await serveApp(page);
    await page.goto(`${server.resolvedUrls!.local[0]}test/mcp-app-host.html`);
    await page.waitForFunction(() => (window as any).host?.ready);
    const app = page.frameLocator("iframe");
    await app.getByText("正在等待結果").waitFor();
    await page.evaluate(async () => {
      const { bridge } = (window as any).host;
      await bridge.sendToolInput({ arguments: { limit: 5 } });
      await bridge.sendToolResult({ content: [], structuredContent: { rows: [{ id: "r1", version: 3, item: "Laptops", date: "2026-10-01T15:20:00.000Z", link: "https://example.com/r1" }] }, _meta: { "net.aotter.mantle/tool": "pending" } });
    });
    await app.getByText("Laptops").waitFor();
    expect(await page.evaluate(() => ({ info: (window as any).host.bridge.getAppVersion(), capabilities: (window as any).host.bridge.getAppCapabilities() })))
      .toEqual({ info: { name: "mantle", version }, capabilities: { availableDisplayModes: ["inline", "fullscreen"] } });
    // the host's time zone and language, not the iframe's
    expect(await app.locator("time").innerText()).toMatch(/^2026\/10\/1\s晚上11:20$/);
    // the sandbox blocks navigation: the link opens through the host
    await app.getByRole("link", { name: "https://example.com/r1" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).host.links)).toEqual(["https://example.com/r1"]);
    const look = await app.getByRole("button", { name: "Review: r1" }).evaluate(node => {
      const style = getComputedStyle(node), root = getComputedStyle(document.documentElement);
      return { radius: style.borderTopLeftRadius, weight: style.fontWeight, dark: document.documentElement.classList.contains("dark"), inset: root.paddingBottom };
    });
    expect(look).toEqual({ radius: "3px", weight: "550", dark: true, inset: "24px" });
    await app.getByRole("button", { name: "全螢幕" }).click();
    await app.getByRole("button", { name: "結束全螢幕" }).waitFor();
    expect(await page.evaluate(() => (window as any).host.modes)).toEqual(["fullscreen"]);
    await app.getByRole("button", { name: "Review: r1" }).click();
    await app.getByRole("button", { name: "Date", exact: true }).click();
    const date = app.locator('input[type="date"]'); await date.waitFor();
    expect(await date.evaluate(node => getComputedStyle(node).paddingTop)).toBe("12px");
    await date.fill("2026-10-15");
    await app.locator('input[type="time"]').fill("12:34");
    // Closing the popover leaves the selected day in the shared form draft.
    await date.press("Escape");
    await app.getByRole("button", { name: "執行", exact: true }).click();
    await page.waitForFunction(() => (window as any).host.calls.length >= 2);
    const state = await page.evaluate(() => ({ calls: (window as any).host.calls, errors: (window as any).host.errors, sizes: (window as any).host.sizes }));
    expect(state.errors).toEqual([]);
    // the model learns of the change at its next turn; the App never speaks for the user
    await expect.poll(() => page.evaluate(() => (window as any).host.contexts)).toEqual([{
      content: [{ type: "text", text: "review_requisition succeeded on row r1; the list was refreshed." }],
      structuredContent: { tool: "review_requisition", id: "r1", outcome: "succeeded" },
    }]);
    expect(await page.evaluate(() => (window as any).host.messages)).toEqual([]);
    expect(state.calls[0]).toMatchObject({ name: "review_requisition", arguments: { id: "r1", expectedVersion: 3 } });
    expect(state.calls[0].arguments.date).toBe(await page.evaluate(() => new Date(2026, 9, 15, 12, 34).toISOString()));
    expect(state.calls[1]).toMatchObject({ name: "pending", arguments: { limit: 5 } });
    expect(state.calls[0]._meta.progressToken).toMatch(/^[a-f0-9-]+:\d+$/);
    expect(state.sizes.length).toBeGreaterThan(0);
    const root = await app.locator("html").evaluate(node => ({ lang: node.lang, theme: node.dataset.theme, color: node.style.getPropertyValue("--color-text-primary") }));
    expect(root).toEqual({ lang: "zh-TW", theme: "dark", color: "rgb(1, 2, 3)" });
    await page.evaluate(() => (window as any).host.bridge.setHostContext({ locale: "en", theme: "light" }));
    await expect.poll(() => app.locator("html").getAttribute("lang")).toBe("en");
    await expect.poll(() => app.locator("html").getAttribute("data-theme")).toBe("light");
  } finally { await browser.close(); await server.close(); }
}, 45_000);

it("is read-only in a host without server tools: rows and plain links, no action and no tool call", async () => {
  const server = await createServer({ configFile: resolve(import.meta.dirname, "../vite.mcp-app.config.ts"), root: resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await serveApp(page);
    await page.goto(`${server.resolvedUrls!.local[0]}test/mcp-app-host.html?read-only`);
    await page.waitForFunction(() => (window as any).host?.ready);
    const app = page.frameLocator("iframe");
    await page.evaluate(async () => {
      await (window as any).host.bridge.sendToolResult({ content: [], structuredContent: { rows: [{ id: "r1", version: 3, item: "Laptops", link: "https://example.com/r1" }] }, _meta: { "net.aotter.mantle/tool": "pending" } });
    });
    await app.getByText("Laptops").waitFor();
    expect(await app.getByRole("button", { name: "Review: r1" }).count()).toBe(0);
    expect(await app.getByRole("link").count()).toBe(0);
    expect(await page.evaluate(() => ({ calls: (window as any).host.calls, errors: (window as any).host.errors }))).toEqual({ calls: [], errors: [] });
  } finally { await browser.close(); await server.close(); }
}, 45_000);

it("pins the parent and origin, ignores malformed input and rejects reverse tool routing; aborts stay uncertain", async () => {
  const server = await createServer({ configFile: resolve(import.meta.dirname, "../vite.mcp-app.config.ts"), root: resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", executablePath: process.env.MANTLE_TEST_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    await page.addInitScript(() => {
      const original = window.setTimeout;
      Object.assign(window, { hostRequestTimers: 0 });
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 60_000) (window as any).hostRequestTimers++;
        return original(handler, timeout, ...args);
      }) as typeof window.setTimeout;
    });
    await page.goto(`${server.resolvedUrls!.local[0]}test/mcp-app-host.html?probe`);
    await page.waitForFunction(() => (window as any).host?.ready);
    const frame = page.frames().find(frame => frame.url().includes("mcp-app-probe.html"))!;
    const counts = await frame.evaluate(() => {
      const notify = { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { unsafe: true } } };
      const inject = (data: unknown, source: Window = window.parent, origin = location.origin) => window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
      inject(notify, window); inject(notify, window.parent, "https://attacker.invalid");
      inject({ ...notify, jsonrpc: "1.0" });
      inject({ ...notify, params: { arguments: [] } });
      inject({ ...notify, params: JSON.parse('{"arguments":{"__proto__":{"polluted":true}}}') });
      const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
      inject({ ...notify, params: { arguments: cyclic } });
      inject({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: 1 }] } });
      inject({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { locale: 1 } });
      inject({ ...notify, id: "reverse", method: "tools/call" });
      inject({ jsonrpc: "2.0", id: "unknown", result: { content: [] } });
      const { inputs, results, contexts } = (window as any).probe;
      return { inputs, results, contexts: contexts.length, polluted: ({} as any).polluted };
    });
    expect(counts).toEqual({ inputs: [], results: [], contexts: 1, polluted: undefined });
    expect(await page.evaluate(() => (window as any).host.calls)).toEqual([]);
    expect(await frame.evaluate(() => {
      const deep: Record<string, unknown> = {}, shared = { constructor: "ordinary data", prototype: "ordinary data" };
      let node = deep;
      for (let i = 0; i < 100; i++) { const next = {}; node["next"] = next; node = next; }
      window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: location.origin,
        data: { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { deep, one: shared, two: shared } } } }));
      const [input] = (window as any).probe.inputs;
      return { accepted: (window as any).probe.inputs.length, shared: input.one === input.two, constructor: input.one.constructor };
    })).toEqual({ accepted: 1, shared: true, constructor: "ordinary data" });
    const cancellation = await frame.evaluate(async () => {
      const signal = new AbortController();
      const promise = (window as any).probe.call("wait", {}, signal.signal);
      setTimeout(() => signal.abort(new Error("user cancelled")), 50);
      try { await promise; return "resolved"; } catch (error) { return (error as Error).message; }
    });
    expect(cancellation).toBe("user cancelled");
    // Initialize + tool request + an actual official-host progress reset.
    expect(await frame.evaluate(() => (window as any).hostRequestTimers)).toBe(3);
    await page.waitForFunction(() => (window as any).host.aborts.length === 1);
    await page.evaluate(async () => { await (window as any).host.bridge.sendToolCancelled({ reason: "host cancelled" }); });
    await expect.poll(() => frame.evaluate(() => (window as any).probe.cancelled)).toBe(1);
    await frame.evaluate(() => (window as any).probe.close());
    expect(await frame.evaluate(async () => { try { await (window as any).probe.call("wait", {}); return "resolved"; } catch (error) { return (error as Error).message; } })).toBe("Invalid tool call");
    await page.goto(`${server.resolvedUrls!.local[0]}test/mcp-app-host.html?bad-handshake`);
    const invalid = page.frames().find(frame => frame.url().includes("mcp-app-probe.html"))!;
    await expect.poll(() => invalid.evaluate(() => (window as any).probe?.errors)).toEqual(["Invalid host handshake"]);
    expect(await page.evaluate(() => (window as any).host.ready)).toBe(false);
    expect(await invalid.evaluate(() => (window as any).probe.call)).toBeUndefined();
  } finally { await browser.close(); await server.close(); }
}, 45_000);
