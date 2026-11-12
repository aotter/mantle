import { expect, test, vi } from "vitest";
import { APP_TOOLS, APP_TOOL_TEXT_LIMIT, callAppTool, type ShownView } from "../admin/src/mcp-app/app-tools";

// Claude's limits for the tools a view registers (claude.com/docs/connectors/building/mcp-apps/app-tools)
test("the App's tool definitions stay within a host's app-tool limits", () => {
  expect(APP_TOOLS.length).toBeLessThanOrEqual(64);
  expect(JSON.stringify(APP_TOOLS).length).toBeLessThanOrEqual(1024 * 1024);
  const depth = (value: unknown): number =>
    value !== null && typeof value === "object" ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0;
  for (const tool of APP_TOOLS) {
    expect(tool.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(tool.inputSchema.type).toBe("object");
    expect(JSON.stringify(tool.inputSchema).length).toBeLessThanOrEqual(64 * 1024);
    expect(depth(tool.inputSchema)).toBeLessThanOrEqual(32);
    // view-only: a host may skip its approval prompt for these
    expect(tool.annotations?.readOnlyHint).toBe(true);
  }
  expect(new Set(APP_TOOLS.map(tool => tool.name)).size).toBe(APP_TOOLS.length);
});

const view = (over: Partial<ShownView> = {}): ShownView => ({
  tool: "pending",
  input: { limit: 2 },
  rows: [{ id: "r1" }, { id: "r2" }, { item: "no id" }],
  more: true,
  loading: false,
  generation: 1,
  loadMore: vi.fn(async () => ({ structuredContent: { rows: [{ id: "r3" }], nextCursor: "c3" } })),
  focus: vi.fn((id: string) => id === "r1"),
  ...over,
});
const signal = new AbortController().signal;
const answer = async (shown: ShownView | null, name: string, args = {}) => callAppTool(() => shown, name, args, signal);
const parsed = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

test("view_state reads the shown View: its tool, input, row ids and whether more rows exist", async () => {
  expect(parsed(await answer(view(), "view_state"))).toEqual({
    tool: "pending",
    input: { limit: 2 },
    rows: 3,
    more: true,
    ids: ["r1", "r2"],
  });
  // no rows on screen (waiting, a page, a row action): nothing to read
  expect(await answer(null, "view_state")).toMatchObject({ isError: true });
  expect(await answer(view(), "delete_row")).toMatchObject({ isError: true });
});

test("view_state keeps within the host's text limit, marking ids it leaves out", async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `${"x".repeat(30)}-${i}` }));
  const result = await answer(view({ rows }), "view_state");
  expect(result.content[0]!.text.length).toBeLessThanOrEqual(APP_TOOL_TEXT_LIMIT);
  const state = parsed(result);
  expect(state.truncated).toBe(true);
  expect(state.rows).toBe(5000);
  expect(state.ids.length).toBeGreaterThan(1000);
  expect(state.ids).toEqual(rows.slice(0, state.ids.length).map(row => row.id));
});

test("view_focus shows a row that is on screen, and only one", async () => {
  const shown = view();
  expect(await answer(shown, "view_focus", { id: "r1" })).toEqual({
    content: [{ type: "text", text: "Showing row r1." }],
  });
  expect(await answer(shown, "view_focus", { id: "r9" })).toMatchObject({ isError: true });
  expect(await answer(shown, "view_focus", { id: 1 })).toMatchObject({ isError: true });
  expect(shown.focus).toHaveBeenCalledTimes(2);
});

test("view_more is Load more: the View's own read, with the host's cancellation; it reads no other server tool", async () => {
  const shown = view();
  expect(parsed(await answer(shown, "view_more"))).toMatchObject({ rows: 4, more: true, ids: ["r1", "r2", "r3"] });
  expect(shown.loadMore).toHaveBeenCalledWith(signal);
  // the tools get no server call of their own: `loadMore` is the only way out, and every refusal skips it
  for (const refused of [
    view({ more: false }),
    view({ loading: true }),
    view({ tool: null }),
    view({ loadMore: undefined }),
  ]) {
    expect(await answer(refused, "view_more")).toMatchObject({ isError: true });
    if (refused.loadMore) expect(refused.loadMore).not.toHaveBeenCalled();
  }
  for (const name of ["view_state", "view_focus"]) {
    const read = view();
    await answer(read, name, { id: "r1" });
    expect(read.loadMore).not.toHaveBeenCalled();
  }
  expect(
    await answer(
      view({ loadMore: async () => ({ isError: true, content: [{ type: "text", text: "no" }] }) }),
      "view_more",
    ),
  ).toMatchObject({ isError: true });
  expect(await answer(view({ loadMore: async () => null }), "view_more")).toMatchObject({ isError: true });
  // a new result replaced the list while the page loaded: the App dropped the page
  let current = view();
  const replaced = view({
    loadMore: async () => {
      current = view({ generation: 2 });
      return { structuredContent: { rows: [{ id: "r3" }] } };
    },
  });
  current = replaced;
  expect(await callAppTool(() => current, "view_more", {}, signal)).toMatchObject({ isError: true });
});
