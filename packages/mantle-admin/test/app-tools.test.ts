import { expect, test, vi } from "vitest";
import {
  APP_TOOLS,
  APP_TOOL_TEXT_LIMIT,
  VIEW_MORE_DEADLINE,
  callAppTool,
  rowId,
  type ShownView,
} from "../admin/src/mcp-app/app-tools";

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
  cursor: "c2",
  loading: false,
  generation: 1,
  loadMore: vi.fn(async () => ({ structuredContent: { rows: [{ id: "r3" }], nextCursor: "c3" } })),
  focus: vi.fn((id: string) => id === "r1"),
  ...over,
});
const signal = new AbortController().signal;
const page = { structuredContent: { rows: [{ id: "r3" }] } };
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
  // no rows on screen (waiting, a page, a row action): a normal answer the model reads, not an error a host may blank
  const none = await answer(null, "view_state");
  expect(none.isError).toBeUndefined();
  expect(none.content[0]!.text).toContain("shows no View's rows now");
  // a tool the App does not have is a real failure
  expect(await answer(view(), "delete_row")).toMatchObject({ isError: true });
});

test("view_state lists a View's number ids as text, the form view_focus takes; a row with no id is only counted", async () => {
  // a View outputs any value as id, a GROUP BY key say
  const rows = [{ id: 7 }, { id: "r1" }, { id: Number.NaN }, { id: { nested: true } }, { item: "no id" }];
  expect(parsed(await answer(view({ rows }), "view_state"))).toMatchObject({ rows: 5, ids: ["7", "r1"] });
  expect(rowId({ id: 7 })).toBe("7");
  expect(rowId({ id: null })).toBeUndefined();
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

test("view_state answers an error, never cut JSON, when the View's input alone is over the text limit", async () => {
  const input = { q: "x".repeat(APP_TOOL_TEXT_LIMIT * 2) };
  const result = await answer(view({ input }), "view_state");
  expect(result).toMatchObject({ isError: true });
  expect(result.content[0]!.text.length).toBeLessThanOrEqual(APP_TOOL_TEXT_LIMIT);
  // just under the limit: whole, valid JSON
  const fits = { q: "x".repeat(APP_TOOL_TEXT_LIMIT - 200) };
  const near = await answer(view({ input: fits }), "view_state");
  expect(near.isError).toBeUndefined();
  expect(near.content[0]!.text.length).toBeLessThanOrEqual(APP_TOOL_TEXT_LIMIT);
  expect(parsed(near).input).toEqual(fits);
});

test("view_focus shows a row that is on screen, and only one", async () => {
  const shown = view();
  expect(await answer(shown, "view_focus", { id: "r1" })).toEqual({
    content: [{ type: "text", text: "Showing row r1." }],
  });
  // an id not shown: the model can pass another, so the answer says what to change instead of an error
  for (const id of ["r9", 1]) {
    const missed = await answer(shown, "view_focus", { id });
    expect(missed.isError).toBeUndefined();
    expect(missed.content[0]!.text).toContain("view_state lists");
  }
  expect(shown.focus).toHaveBeenCalledTimes(2);
});

test("view_more gives up on its read before the host's 45-second limit, and answers", async () => {
  expect(VIEW_MORE_DEADLINE).toBeLessThan(45_000);
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort());
  const slow = view({ loadMore: vi.fn(async (read: AbortSignal) => (read.aborted ? null : page)) });
  const result = await answer(slow, "view_more");
  expect(timeout).toHaveBeenCalledWith(VIEW_MORE_DEADLINE);
  expect(result).toEqual({ content: [{ type: "text", text: "Could not load more rows." }], isError: true });
  timeout.mockRestore();
});

test("view_more is Load more: the View's own read, with the host's cancellation; it reads no other server tool", async () => {
  const shown = view();
  expect(parsed(await answer(shown, "view_more"))).toMatchObject({ rows: 4, more: true, ids: ["r1", "r2", "r3"] });
  // the host's cancellation reaches the read
  const host = new AbortController();
  const cancelled = view({ loadMore: vi.fn(async (read: AbortSignal) => (host.abort(), read.aborted ? null : page)) });
  expect(await callAppTool(() => cancelled, "view_more", {}, host.signal)).toMatchObject({ isError: true });
  // a host that answers the page's own cursor again: the list ends there, not a page loaded forever
  const repeated = view({ loadMore: async () => ({ structuredContent: { rows: [{ id: "r3" }], nextCursor: "c2" } }) });
  expect(parsed(await answer(repeated, "view_more"))).toMatchObject({ rows: 4, more: false });
  // the tools get no server call of their own: `loadMore` is the only way out, and every refusal skips it. A refusal is
  // a normal answer saying what was not done: the model can act on it, and a host may not pass an error's text on.
  for (const [refused, says] of [
    [view({ cursor: undefined }), "no more rows"],
    [view({ loading: true }), "call view_state"],
    [view({ tool: null }), "cannot load more rows"],
    [view({ loadMore: undefined }), "cannot load more rows"],
  ] as const) {
    const result = await answer(refused, "view_more");
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain(says);
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
  const dropped = await callAppTool(() => current, "view_more", {}, signal);
  expect(dropped.isError).toBeUndefined();
  expect(dropped.content[0]!.text).toContain("call view_state");
});
