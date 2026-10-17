import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MantleApp, appValue, pagesReducer, type Pages } from "../admin/src/mcp-app/app";
import type { HostApi } from "../src/app/postmessage.js";
import { adminMcpApps } from "../src/server/mcp.js";
import { defineAdmin } from "../admin/src/app/define-admin.js";
import { SurfaceProvider } from "../admin/src/app/slots.js";
import { actionsFor, APP_TOOL_META_KEY, hiddenInputs, invokeTool, outputOf, readCatalog, nextCursorOf, rowsOf, toolOf, type AppCatalog, type ToolResult } from "../src/app/bridge.js";

const action = {
  capability: "review_requisition",
  title: { en: "Review requisition", "zh-TW": "審核請購" },
  inputSchema: { type: "object", properties: { id: { type: "string" }, expectedVersion: { type: "number" }, requestId: { type: "string", "x-mcp-hint": "idempotency-key" }, note: { type: "string", title: "Note" } } },
  bind: [{ input: "id", field: "id" }],
  version: "expectedVersion",
  mutates: true,
};
const catalog: AppCatalog = {
  views: {
    pending: {
      title: "Pending",
      columns: { created_at: { type: "string", format: "date-time" }, item: { type: "string", title: { en: "Item", "zh-TW": "品項" } }, totalMinor: { type: "integer", title: { en: "Total", "zh-TW": "總額" }, "x-mcp-hint": "money-minor" }, requestStatus: { type: "string", oneOf: [{ const: "submitted", title: { en: "Submitted", "zh-TW": "已送出" } }] } },
      list: { columns: ["item", "totalMinor", "requestStatus", "created_at"] },
      actions: ["review_requisition", "gone"],
    },
  },
  actions: { review_requisition: action },
};
const viewResult: ToolResult = {
  content: [{ type: "text", text: "{}" }],
  structuredContent: { rows: [{ id: "r1", version: 3, item: "Laptops", totalMinor: 123456, requestStatus: "submitted", created_at: "2026-10-01T15:20:14.841000Z" }, { id: "r2", item: "Desks", totalMinor: 1, requestStatus: "submitted" }] },
  _meta: { [APP_TOOL_META_KEY]: "pending" },
};

describe("MCP App bridge", () => {
  it("reads the embedded catalog, the tool a result came from, and its rows", () => {
    const doc = { getElementById: (id: string) => (id === "mantle-catalog" ? { textContent: JSON.stringify(catalog) } : null) } as unknown as Document;
    expect(readCatalog(doc)).toEqual(catalog);
    expect(readCatalog({ getElementById: () => null } as unknown as Document)).toEqual({ views: {}, actions: {} });
    expect(toolOf(viewResult)).toBe("pending");
    expect(toolOf({}, "from_host")).toBe("from_host");
    expect(rowsOf(viewResult)).toHaveLength(2);
    expect(rowsOf({ ...viewResult, isError: true })).toBeNull();
    expect(outputOf({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(hiddenInputs(action)).toEqual(["id", "expectedVersion", "requestId"]);
  });

  it("offers a locking action only on a row carrying its version, and only actions the catalog describes", () => {
    const [r1, r2] = rowsOf(viewResult)!;
    expect(actionsFor(catalog, catalog.views["pending"]!, r1!)).toEqual([action]);
    expect(actionsFor(catalog, catalog.views["pending"]!, r2!)).toEqual([]);
  });

  it("reads diagnostics from the text block of a tool with an output schema", async () => {
    const call = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics: [{ code: "CONFLICT", message: "Moved." }] }) }] }));
    expect(await invokeTool(call, "x", {}, new AbortController().signal)).toEqual({ ok: false, diagnostics: [{ code: "CONFLICT", message: "Moved." }] });
  });

  it("maps tool answers to controller outcomes: diagnostics refuse, anything else is uncertain", async () => {
    const diagnostic = { code: "CONFLICT", message: "Moved." };
    const call = vi.fn()
      .mockResolvedValueOnce({ structuredContent: { id: "r1" } })
      .mockResolvedValueOnce({ isError: true, structuredContent: { diagnostics: [diagnostic] } })
      .mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Tool failed" }] });
    const signal = new AbortController().signal;
    expect(await invokeTool(call, "x", {}, signal)).toEqual({ ok: true, data: { id: "r1" } });
    expect(await invokeTool(call, "x", {}, signal)).toEqual({ ok: false, diagnostics: [diagnostic] });
    await expect(invokeTool(call, "x", {}, signal)).rejects.toThrow("Tool failed");
  });

});

describe("MantleApp", () => {
  const host = (capabilities: HostApi["capabilities"] = { serverTools: {} }): HostApi => ({ capabilities, ...(capabilities.serverTools ? { call: vi.fn() } : {}), openLink: vi.fn(), sendMessage: vi.fn(), updateModelContext: vi.fn(), requestDisplayMode: vi.fn() });
  const render = (props: Partial<Parameters<typeof MantleApp>[0]> = {}) => renderToStaticMarkup(<MantleApp catalog={catalog} host={host()} result={viewResult} input={{}} {...props} />);

  it("shows rows as Admin does: field titles, money, option titles, and the row's actions", () => {
    const html = render();
    expect(html).toContain("Laptops");
    expect(html).toContain("<dt class=\"text-muted-foreground\">Total</dt>");
    expect(html).toContain("1,234.56");
    expect(html).toContain("Submitted");
    // Each row's button names its row for assistive technology; the row without a version cannot lock one.
    expect(html).toContain('aria-label="Review requisition: r1"');
    expect(html).not.toContain('aria-label="Review requisition: r2"');
  });

  it("shows a column through the application's cell:view component, which sees the App's surface and can wrap the built-in cell", () => {
    const { layers } = defineAdmin({}, { components: { "cell:view:pending.item": ({ value, surface, row, renderDefault, ...props }) => <mark data-surface={surface} data-row={String(row["id"])}>{renderDefault({ ...props, row, value: `${value}!` })}</mark> } });
    const html = renderToStaticMarkup(<SurfaceProvider surface="mcp-app" host={null} layers={layers}><MantleApp catalog={catalog} host={host()} result={viewResult} input={{}} /></SurfaceProvider>);
    expect(html).toContain('<mark data-surface="mcp-app" data-row="r1">Laptops!</mark>');
    // only the column it names
    expect(html).toContain("1,234.56");
    expect(html).not.toContain("<mark data-surface=\"mcp-app\" data-row=\"r1\">1,234");
  });

  it("shows a page declared for the host's tool instead of that View's rows, and the rows of any other tool", () => {
    const pages = { pending: <p>queue-page</p> };
    const shown = render({ pages });
    expect(shown).toContain("queue-page");
    expect(shown).not.toContain("Laptops");
    expect(render({ pages, result: { ...viewResult, _meta: { [APP_TOOL_META_KEY]: "other" } } })).toContain("Laptops");
    // a failed call still says so; the page never hides a refusal
    const failed: ToolResult = { isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics: [{ code: "FORBIDDEN", message: "Not allowed." }] }) }] };
    expect(render({ pages, result: { ...failed, _meta: { [APP_TOOL_META_KEY]: "pending" } } })).toContain("Not allowed.");
  });

  it("speaks the host's locale, in its own strings and in the plan's titles", () => {
    const html = render({ locale: "zh-TW" });
    expect(html).toContain("總額");
    // the entry's own timestamp, which no Schema titles, in the App's language
    expect(html).toContain("建立時間");
    expect(html).toContain("品項");
    expect(html).toContain("已送出");
    expect(html).toContain("審核請購");
    expect(render({ result: null, locale: "zh-Hans-CN" })).toContain("正在等待结果");
    expect(render({ result: null, locale: "fr" })).toContain("Waiting for results");
  });

  it("shows a View the catalog does not describe as its rows, and a failed or cancelled View instead of waiting", () => {
    const failed: ToolResult = { isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics: [{ code: "FORBIDDEN", message: "Not allowed." }] }) }] };
    expect(render({ result: failed })).toContain("Not allowed.");
    expect(render({ result: null, cancelled: true })).toContain("cancelled");
    const bare = render({ result: { ...viewResult, _meta: {} } });
    expect(bare).toContain("Laptops");
    expect(bare).toContain("123456");
    expect(bare).not.toContain("Review requisition");
  });

  it("offers Load more for a page with a next cursor, and only where the host has server tools", () => {
    const paged: ToolResult = { ...viewResult, structuredContent: { ...viewResult.structuredContent, nextCursor: "c2" } };
    expect(nextCursorOf(paged)).toBe("c2");
    expect(nextCursorOf(viewResult)).toBeUndefined();
    expect(render({ result: paged })).toContain(">Load more</button>");
    expect(render({ result: paged, locale: "zh-TW" })).toContain(">載入更多</button>");
    expect(render()).not.toContain("Load more");
    expect(render({ result: paged, host: host({}) })).not.toContain("Load more");
  });

  it("appends a loaded page to the rows, and drops a page that arrives after a new or refreshed result replaced the list", () => {
    const page = (ids: string[], nextCursor?: string): ToolResult => ({ structuredContent: { rows: ids.map((id) => ({ id })), ...(nextCursor ? { nextCursor } : {}) } });
    const first = pagesReducer({ rows: null, cursor: undefined, more: "idle", generation: 0 }, { type: "reset", result: page(["a"], "c2") });
    expect(first).toMatchObject({ rows: [{ id: "a" }], cursor: "c2", more: "idle" });
    const loading = pagesReducer(first, { type: "loading" });
    expect(loading.more).toBe("loading");
    const appended = pagesReducer(loading, { type: "loaded", generation: loading.generation, result: page(["b"]) });
    expect(appended).toMatchObject({ rows: [{ id: "a" }, { id: "b" }], cursor: undefined, more: "idle" });
    // a new result (or a refresh) while the page was in flight: the old page is for a list that is gone
    const replaced = pagesReducer(loading, { type: "reset", result: page(["x"], "d2") });
    expect(pagesReducer(replaced, { type: "loaded", generation: loading.generation, result: page(["b"]) })).toBe(replaced);
    expect(pagesReducer(replaced, { type: "failed", generation: loading.generation })).toBe(replaced);
    expect(replaced).toMatchObject({ rows: [{ id: "x" }], cursor: "d2", more: "idle" });
    // a refresh clears the "could not load more" notice
    const failed: Pages = pagesReducer(loading, { type: "failed", generation: loading.generation });
    expect(failed.more).toBe("failed");
    expect(pagesReducer(failed, { type: "reset", result: page(["a"]) }).more).toBe("idle");
    expect(pagesReducer(loading, { type: "loaded", generation: loading.generation, result: { isError: true } }).more).toBe("failed");
  });

  it("is read-only when the host offers no server tools: the rows, but no action to open", () => {
    const html = render({ host: host({}) });
    expect(html).toContain("Laptops");
    expect(html).not.toContain("Review requisition");
  });

  it("shows date-times in the host's time zone and language, and opens http(s) links only through a host that can", () => {
    const at = "2026-10-01T15:20:00.000Z", date = { type: "string", format: "date-time" } as const;
    // ICU spaces vary by version
    expect(renderToStaticMarkup(<>{appValue(date, at, "en-US", "Asia/Taipei")}</>)).toMatch(new RegExp(`^<time dateTime="${at}">10/1/26,\\s11:20\\sPM</time>$`));
    expect(renderToStaticMarkup(<>{appValue(date, at, "en-US", "America/New_York")}</>)).toMatch(/11:20\sAM/);
    expect(renderToStaticMarkup(<>{appValue({ type: "integer", "x-mcp-hint": "timestamp-ms" }, Date.parse(at), "zh-TW", "Asia/Taipei")}</>)).toMatch(/^2026\/10\/1\s晚上11:20$/);
    const uri = { type: "string", format: "uri" } as const, openLink = vi.fn();
    expect(renderToStaticMarkup(<>{appValue(uri, "https://example.com/a", "en", undefined, openLink)}</>)).toBe('<a href="https://example.com/a" class="underline">https://example.com/a</a>');
    expect(renderToStaticMarkup(<>{appValue(uri, "javascript:alert(1)", "en", undefined, openLink)}</>)).toBe("javascript:alert(1)");
    expect(renderToStaticMarkup(<>{appValue(uri, "https://example.com/a", "en")}</>)).toBe("https://example.com/a");
  });
});

describe("adminMcpApps", () => {
  it("retains old HTML and CSP after a UI upgrade, without claiming current tools or sharing a caller's catalogue", async () => {
    const context = { env: {}, request: new Request("https://app.test/mcp") };
    const resolve = async (source: ReturnType<typeof adminMcpApps>) => typeof source === "function" ? source(context) : source;
    const read = async (resource: Awaited<ReturnType<typeof resolve>>["resources"][number], tools: string[]) => {
      const page = typeof resource.html === "string" ? resource.html : await resource.html({ ...context, tools: new Set(tools) });
      return typeof page === "string" ? { html: page } : page;
    };
    const old = (await resolve(adminMcpApps({ catalogue: catalog, html: "<head></head><h1>Build A</h1>", domain: "old.apps.example" }))).resources[0]!;
    const snapshot = { uri: old.uri, ...await read(old, ["pending", "review_requisition"]), csp: { resourceDomains: ["https://old.assets.example"] }, domain: old.domain };
    const upgraded = await resolve(adminMcpApps({ catalogue: catalog, html: "<head></head><h1>Build B</h1>", title: "New title", previous: [{ ...snapshot, title: "Original title" }] }));
    expect(upgraded.resources).toHaveLength(2);
    const [current, retained] = upgraded.resources;
    expect(current!.uri).not.toBe(old.uri);
    expect(retained!.uri).toBe(old.uri);
    expect(retained!.renders).toBeUndefined();
    expect(retained!.appOnly).toBeUndefined();
    expect(retained!.domain).toBe("old.apps.example");
    expect(retained!.title).toBe("Original title");
    const restricted = await read(retained!, []);
    expect(restricted.csp).toEqual(snapshot.csp);
    expect(restricted.html).toContain("Build A");
    expect(restricted.html).not.toContain("Build B");
    expect(restricted.html).not.toContain("review_requisition");
    expect(restricted.html).not.toContain('"pending"');
    expect((restricted.html.match(/id="mantle-catalog"/g) ?? [])).toHaveLength(1);
    expect((await read(retained!, ["pending"])).html).toContain('"pending"');
    expect((await read(retained!, ["pending"])).html).not.toContain("review_requisition");
    expect((await read(retained!, ["pending", "review_requisition"])).html).toBe(snapshot.html);

    // The real MCP handler advertises B but still reads A; it does not alias A to B.
    const { mcp } = await import("@aotter/mantle/mcp");
    const api = mcp([{ name: "pending", surface: "public", path: "pending", description: "Rows", inputSchema: { type: "object" }, validate: () => ({}), page: async () => ({ rows: [] }) }], {
      db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: upgraded },
    });
    const request = async (method: string, params = {}) => {
      const response = await api(new Request("https://app.test/mcp/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), {});
      const text = await response!.text();
      return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text).result;
    };
    const listed = await request("tools/list");
    expect(listed.tools[0]._meta.ui.resourceUri).toBe(current!.uri);
    const oldRead = await request("resources/read", { uri: old.uri });
    expect(oldRead.contents[0].text).toContain("Build A");
    expect(oldRead.contents[0].text).not.toContain("review_requisition");
    expect(oldRead.contents[0]._meta.ui.csp).toEqual(snapshot.csp);
    // A no-op redeploy does not register the same immutable URI twice.
    expect((await resolve(adminMcpApps({ catalogue: catalog, html: "<head></head><h1>Build A</h1>", domain: "old.apps.example", previous: [snapshot] }))).resources).toHaveLength(1);
  });

  it("refuses malformed retained pages rather than serving the latest page under their old URI", () => {
    for (const snapshot of [{ uri: "ui://foreign/app", html: "<head></head>" }, { uri: "ui://mantle-admin/old", html: '<script type="application/json" id="mantle-catalog">{bad}</script>' }]) {
      expect(() => adminMcpApps({ catalogue: catalog, html: "<head></head>", previous: [snapshot] })).toThrow("retained Admin App");
    }
  });

  it("injects the catalogue right after the opening <head>, even when a script in it holds the text </head>", async () => {
    const html = '<!doctype html><html><head><script type="module">const srcDoc = "<html><head></head></html>";</script></head><body></body></html>';
    const source = adminMcpApps({ catalogue: catalog, html });
    const [resource] = (typeof source === "function" ? await source({ env: {}, request: new Request("https://app.test/mcp") }) : source).resources;
    const out = (await (resource!.html as (render: object) => Promise<{ html: string }>)({ tools: new Set(["pending"]), env: {}, request: new Request("https://app.test/mcp") })).html;
    expect(out).toMatch(/^<!doctype html><html><head><script type="application\/json" id="mantle-catalog">/);
    // the module script is whole
    expect(out).toContain('<script type="module">const srcDoc = "<html><head></head></html>";</script>');
  });

  it("embeds the catalogue as this caller sees it: no View or action its tools/list hides", async () => {
    const source = adminMcpApps({ catalogue: catalog, html: "<head></head>", domain: "admin.apps.example" });
    const [resource] = (typeof source === "function" ? await source({ env: {}, request: new Request("https://app.test/mcp") }) : source).resources;
    expect(resource!.domain).toBe("admin.apps.example");
    const embedded = async (tools: string[]) => JSON.parse((await (resource!.html as (render: { tools: Set<string> }) => Promise<{ html: string }>)({ tools: new Set(tools) })).html.match(/<script[^>]*>(.*)<\/script>/)![1]!) as unknown;
    // "gone" is no tool of this caller's either
    expect(await embedded(["pending", "review_requisition"])).toEqual({ ...catalog, views: { pending: { ...catalog.views["pending"], actions: ["review_requisition"] } } });
    expect(await embedded(["pending"])).toEqual({ views: { pending: { ...catalog.views["pending"], actions: [] } }, actions: {} });
    expect(await embedded(["review_requisition"])).toEqual({ views: {}, actions: { review_requisition: action } });
  });
});
