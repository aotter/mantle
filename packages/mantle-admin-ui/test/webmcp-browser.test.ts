import { expect, it } from "vitest";
import { chromium } from "playwright";
import { createServer } from "vite";
import { resolve } from "node:path";

it("hides unsupported WebMCP and binds staff tools, navigation and localized prompt when supported", async () => {
  const server = await createServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    await page.addInitScript(() => {
      localStorage.setItem("cms.preference.language", "zh-TW");
      history.replaceState(null, "", "/admin");
      const tools = new Map();
      Object.assign(window, { testTools: tools });
      Object.defineProperty(document, "modelContext", { configurable: true, value: undefined });
      if (sessionStorage.getItem("webmcp")) Object.defineProperty(document, "modelContext", { configurable: true, value: {
        registerTool: async (tool: { name: string }, options: { signal: AbortSignal }) => {
          if (tools.has(tool.name)) throw new Error("duplicate");
          tools.set(tool.name, tool);
          options.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
        },
      } });
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { Object.assign(window, { copiedPrompt: text }); } } });
    });
    const staffTool = { name: "query_view_report", description: "Canonical staff report description", inputSchema: { type: "object" } };
    let fail = false;
    const calls: unknown[] = [];
    await page.route("**/admin/api/**", async route => {
      const path = new URL(route.request().url()).pathname.replace("/admin/api", "");
      if (path === "/mcp") {
        // A minimal Streamable HTTP server: the official client initializes,
        // notifies, then calls; it may also probe the standalone GET stream.
        if (route.request().method() !== "POST") return route.fulfill({ status: 405 });
        const message = route.request().postDataJSON() as { id?: number; method: string; params?: { protocolVersion?: string } };
        if (message.id === undefined) return route.fulfill({ status: 202 });
        if (message.method === "initialize") return route.fulfill({ json: { jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" },
        } } });
        calls.push(message);
        const text = fail ? JSON.stringify({ diagnostics: [{ code: "CONFLICT", message: "Stale version" }] }) : '{"rows":[]}';
        return route.fulfill({ json: { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], ...(fail ? { isError: true } : {}) } } });
      }
      return route.fulfill({ json: path === "/me" ? { role: "owner", login: "owner" }
        : path === "/site" ? { brand: "WebMCP test", icons: [], canonicalLocale: "en" }
        : path === "/collections" ? { collections: [] }
        : path === "/operations" ? { operations: [] }
        : path === "/views-manifest" ? { views: [] }
        : path === "/developer-console" ? { dataModel: { schemas: [], views: [] }, logic: { triggers: [], procedures: [] }, interfaces: { http: [], callable: [] }, graph: { atoms: [], relations: [] } }
        : path === "/webmcp" ? { tools: [staffTool], routes: { query_view_report: { path: "/admin/views/report" } } }
        : path === "/views/report" ? { ok: true, data: { rows: [], page: 1, show: 50, hasMore: false } } : {} });
    });
    await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);
    await page.locator("header").waitFor();
    expect(await page.getByRole("button", { name: "與 AI agent 一起操作" }).count()).toBe(0);
    await page.evaluate(() => sessionStorage.setItem("webmcp", "1"));
    await page.goto(new URL("/_mantle/admin/", server.resolvedUrls!.local[0]!).href);
    await page.getByRole("button", { name: "與 AI agent 一起操作" }).click();
    expect(await page.getByText("3 WebMCP tools").isVisible()).toBe(true);
    await page.getByRole("button", { name: "複製提示詞" }).click();
    expect(await page.evaluate(() => (window as unknown as { copiedPrompt: string }).copiedPrompt)).toContain("admin_get_context");
    expect(await page.evaluate(() => (window as unknown as { copiedPrompt: string }).copiedPrompt)).not.toContain("create_media_upload");
    await page.keyboard.press("Escape");
    const invoke = (name: string, input = {}) => page.evaluate(async ({ name, input }) => {
      const tools = (window as unknown as { testTools: Map<string, { execute(input: unknown): Promise<unknown> }> }).testTools;
      try { return { ok: true, result: await tools.get(name)!.execute(input) }; }
      catch (error) { return { ok: false, message: (error as Error).message }; }
    }, { name, input });
    expect(await page.evaluate(() => (window as unknown as { testTools: Map<string, { description: string }> }).testTools.get("query_view_report")!.description)).toBe(staffTool.description);
    expect((await invoke("query_view_report")).ok).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/admin/views/report");
    await invoke("admin_navigate", { path: "/admin" });
    fail = true;
    expect(await invoke("query_view_report")).toMatchObject({ result: { isError: true, structuredContent: { diagnostic: { code: "CONFLICT" } } } });
    expect(new URL(page.url()).pathname).toBe("/admin");
    expect(calls).toHaveLength(2);
    expect(await invoke("admin_navigate", { path: "https://evil.test" })).toMatchObject({ result: { isError: true } });
    await invoke("admin_navigate", { path: "/admin/dev/docs/webmcp" });
    await page.getByText(staffTool.description).last().waitFor({ state: "visible" });
  } finally { await browser.close(); await server.close(); }
}, 30_000);
