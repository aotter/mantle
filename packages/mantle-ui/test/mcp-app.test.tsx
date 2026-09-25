import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InteractionApp } from "../src/mcp-app/app.js";
import { hiddenInputs, INTERACTION_META_KEY, invokeTool, outputOf, readEntry, viewOf, type ToolResult } from "../src/mcp-app/bridge.js";

const action = {
  capability: "review_requisition",
  title: "Review requisition",
  inputSchema: { type: "object", properties: { id: { type: "string" }, expectedVersion: { type: "number" }, requestId: { type: "string", "x-mcp-hint": "idempotency-key" }, note: { type: "string", title: "Note" } } },
  bind: [{ input: "id", field: "id" }],
  version: "expectedVersion",
  mutates: true,
};
const viewResult: ToolResult = {
  content: [{ type: "text", text: "{}" }],
  structuredContent: { rows: [{ id: "r1", version: 3, item: "Laptops" }], page: 1, show: 20, hasMore: false },
  _meta: { [INTERACTION_META_KEY]: { view: "query_view_pending", collection: "requisitions", rowActions: [action] } },
};

describe("MCP App bridge", () => {
  it("reads the View, its rows and row actions from a tool result", () => {
    expect(viewOf(viewResult)).toMatchObject({ view: "query_view_pending", collection: "requisitions", rows: [{ id: "r1" }], rowActions: [action] });
    expect(viewOf({ content: [{ type: "text", text: "{}" }] })).toBeNull();
    expect(outputOf({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(hiddenInputs(action)).toEqual(["id", "expectedVersion", "requestId"]);
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

  it("reads the entry through the reader the server names", async () => {
    const call = vi.fn(async () => ({ structuredContent: { id: "r1", version: 4, data: { item: "Laptops" } } }));
    expect(await readEntry(call, "read_entry", "requisitions", "r1", new AbortController().signal)).toEqual({ id: "r1", version: 4, data: { item: "Laptops" } });
    expect(call).toHaveBeenCalledWith("read_entry", { collection: "requisitions", id: "r1" }, expect.any(AbortSignal));
    expect(viewOf(viewResult)?.read).toBeNull();
  });

  it("reads diagnostics from the text block of a tool with an output schema", async () => {
    const call = vi.fn(async () => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics: [{ code: "CONFLICT", message: "Moved." }] }) }] }));
    expect(await invokeTool(call, "x", {}, new AbortController().signal)).toEqual({ ok: false, diagnostics: [{ code: "CONFLICT", message: "Moved." }] });
  });

  it("treats a View without row actions as a View, and an error result as no View", () => {
    const bare: ToolResult = { ...viewResult, _meta: { [INTERACTION_META_KEY]: { view: "query_view_mine", collection: "requisitions", rowActions: [] } } };
    expect(viewOf(bare)).toMatchObject({ rows: [{ id: "r1" }], rowActions: [] });
    expect(viewOf({ ...viewResult, isError: true })).toBeNull();
  });
});

describe("InteractionApp", () => {
  it("lists the rows with their actions, and waits when there is no result yet", () => {
    const html = renderToStaticMarkup(<InteractionApp call={vi.fn()} result={viewResult} input={{}} />);
    expect(html).toContain("Laptops");
    expect(html).toContain("Review requisition");
    expect(renderToStaticMarkup(<InteractionApp call={vi.fn()} result={null} input={null} />)).toContain("Waiting for results");
    // Each row's button names its row for assistive technology.
    expect(html).toContain('aria-label="Review requisition: r1"');
  });

  it("shows a failed or cancelled View instead of waiting", () => {
    const failed: ToolResult = { isError: true, content: [{ type: "text", text: JSON.stringify({ diagnostics: [{ code: "FORBIDDEN", message: "Not allowed." }] }) }] };
    const html = renderToStaticMarkup(<InteractionApp call={vi.fn()} result={failed} input={{}} />);
    expect(html).toContain("These results could not be shown.");
    expect(html).toContain("Not allowed.");
    expect(renderToStaticMarkup(<InteractionApp call={vi.fn()} result={null} input={null} cancelled />)).toContain("cancelled");
  });

  it("speaks the host's locale", () => {
    expect(renderToStaticMarkup(<InteractionApp call={vi.fn()} result={null} input={null} locale="zh-TW" />)).toContain("正在等待結果");
    expect(renderToStaticMarkup(<InteractionApp call={vi.fn()} result={null} input={null} locale="zh-Hans-CN" />)).toContain("正在等待结果");
    expect(renderToStaticMarkup(<InteractionApp call={vi.fn()} result={null} input={null} locale="fr" />)).toContain("Waiting for results");
  });
});
