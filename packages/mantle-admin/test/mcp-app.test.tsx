import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MantleApp } from "../src/mcp-app/app.js";
import { actionsFor, APP_TOOL_META_KEY, hiddenInputs, invokeTool, outputOf, readCatalog, rowsOf, toolOf, type AppCatalog, type ToolResult } from "../src/app/bridge.js";

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
  const render = (props: Partial<Parameters<typeof MantleApp>[0]> = {}) => renderToStaticMarkup(<MantleApp catalog={catalog} call={vi.fn()} result={viewResult} input={{}} {...props} />);

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
});
