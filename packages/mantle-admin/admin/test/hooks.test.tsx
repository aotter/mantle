import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUnavailableError, mcpAppTransport, useAdminSurface, useCollectionTotal, useEntries, useEntry, useHost, useMe, useOperation, useView, type AdminHost, type AdminTransport, type McpToolResult } from "../src/app/hooks";
import { AdminHooksProvider } from "../src/app/hooks-context";
import { browserTransport } from "../src/app/transport";
import type { AdminMeta } from "../src/app/define-admin";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); });
const stubFetch = (...replies: Response[]) => { vi.stubGlobal("fetch", fetchMock); for (const reply of replies) fetchMock.mockResolvedValueOnce(reply); };
const called = (n = 0) => ({ url: fetchMock.mock.calls[n]![0], init: fetchMock.mock.calls[n]![1] });

describe("browser transport", () => {
  it("reads a View over the admin route, leaving out empty input", async () => {
    stubFetch(json({ rows: [{ id: "a" }], nextCursor: "c2" }));
    const reply = await browserTransport.view("pending requests", { q: "x y", empty: "", none: null }, { limit: 5, cursor: undefined });
    expect(reply).toEqual({ status: "ok", data: { rows: [{ id: "a" }], nextCursor: "c2" } });
    expect(called().url).toBe("/admin/api/views/pending%20requests?q=x+y&limit=5");
    expect(called().init).toMatchObject({ credentials: "same-origin" });
  });

  it("reads entries with one filter, an entry, a total and the caller", async () => {
    stubFetch(json({ items: [{ id: "1" }], next_cursor: "n" }), json({ entry: { id: "1", data: { title: "t" } }, related: [] }), json({ total: 7, buckets: [] }), json({ userId: "u", role: "admin", admin: true, login: null, image: null }));
    expect(await browserTransport.entries("requests", { filter: { field: "status", value: "open" }, search: "pay", limit: 20, cursor: "c" })).toEqual({ status: "ok", data: { items: [{ id: "1" }], nextCursor: "n" } });
    expect(called(0).url).toBe("/admin/api/entries?collection=requests&limit=20&search=pay&cursor=c&filter_field=status&filter_value=open");
    expect(await browserTransport.entry("requests", "a/b")).toEqual({ status: "ok", data: { id: "1", data: { title: "t" } } });
    expect(called(1).url).toBe("/admin/api/entries/a%2Fb?collection=requests");
    expect(await browserTransport.total("requests")).toEqual({ status: "ok", data: 7 });
    expect(called(2).url).toBe("/admin/api/collections/requests/statistics?range=7d");
    expect(await browserTransport.me()).toMatchObject({ status: "ok", data: { userId: "u" } });
    expect(called(3).url).toBe("/admin/api/me");
  });

  it("runs an operation and returns its output", async () => {
    stubFetch(json({ ok: true, output: { results: [] } }));
    expect(await browserTransport.run("restock", { sku: "a" })).toEqual({ status: "ok", data: { results: [] } });
    expect(called().url).toBe("/admin/api/operations/restock");
    expect(called().init).toMatchObject({ method: "POST", body: JSON.stringify({ sku: "a" }) });
  });

  it("reads a 403 and a 404 as the same unavailable, and any other failure as an error", async () => {
    for (const status of [403, 404]) {
      stubFetch(json({ error: { code: status === 403 ? "AUTH_DENIED" : "NOT_FOUND", message: "no" } }, status));
      expect(await browserTransport.view("v", {}, {})).toEqual({ status: "unavailable" });
    }
    stubFetch(json({ error: { code: "AUTH_DENIED", message: "no" } }, 403), json({ error: { code: "NOT_FOUND", message: "no" } }, 404));
    expect(await browserTransport.run("op", {})).toEqual({ status: "unavailable" });
    expect(await browserTransport.entry("c", "1")).toEqual({ status: "unavailable" });
    // a policy that refuses the caller the Schema answers 200 with a stub that has no data: a refusal too
    stubFetch(json({ entry: { id: "1", version: 2 }, related: [] }));
    expect(await browserTransport.entry("c", "1")).toEqual({ status: "unavailable" });
    // a collection without statistics answers 501: nothing to total
    stubFetch(json({ error: { code: "STATISTICS_UNAVAILABLE", message: "no" } }, 501), json({ error: { message: "boom" } }, 500));
    expect(await browserTransport.total("c")).toEqual({ status: "unavailable" });
    await expect(browserTransport.me()).rejects.toThrow("boom");
  });
});

const result = (structuredContent: Record<string, unknown>, isError = false): McpToolResult => ({ structuredContent, isError });
function host(capabilities: Record<string, unknown> = { serverTools: {} }): AdminHost & { updateModelContext: ReturnType<typeof vi.fn> } {
  return { context: {}, capabilities, openLink: async () => true, sendMessage: async () => true, updateModelContext: vi.fn(async () => true), requestDisplayMode: async () => null };
}

describe("MCP App transport", () => {
  it("calls the View's tool through the host, with paging", async () => {
    const call = vi.fn(async () => result({ rows: [{ id: "a" }, "junk"], nextCursor: "c2" }));
    const transport = mcpAppTransport({ call, host: host() });
    expect(transport).toMatchObject({ surface: "mcp-app", writable: true });
    expect(await transport.view("pending-requests", { q: 1 }, { limit: 10, cursor: "c" })).toEqual({ status: "ok", data: { rows: [{ id: "a" }], nextCursor: "c2" } });
    expect(call).toHaveBeenCalledWith("pending_requests", { q: 1, limit: 10, cursor: "c" });
  });

  it("derives the tool from the name, and gives rows the names the browser route gives them", async () => {
    const call = vi.fn(async () => result({ rows: [{ id: "a", prioritylevel: 2, title: "t" }] }));
    const transport = mcpAppTransport({ call, host: host() });
    expect(await transport.view("Task-Board", {}, {}, { prioritylevel: "priorityLevel" })).toEqual({ status: "ok", data: { rows: [{ id: "a", priorityLevel: 2, title: "t" }] } });
    expect(call).toHaveBeenCalledWith("task_board", {});
    await transport.run("mark-Done", { id: "1" });
    expect(call).toHaveBeenLastCalledWith("mark_done", { id: "1" });
  });

  it("reads a call the host rejects as refused (an unknown tool, a 403) as unavailable, any other rejection as an error", async () => {
    const reject = (error: unknown) => mcpAppTransport({ call: async () => { throw error; }, host: host() });
    for (const error of [Object.assign(new Error("Unknown tool"), { code: -32602 }), Object.assign(new Error("Forbidden"), { status: 403 })]) {
      expect(await reject(error).view("v", {}, {})).toEqual({ status: "unavailable" });
      expect(await reject(error).run("op", {})).toEqual({ status: "unavailable" });
    }
    await expect(reject(new Error("offline")).view("v", {}, {})).rejects.toThrow("offline");
  });

  it("has no route behind entries, totals or the caller: unavailable, with no tool call and no fetch", async () => {
    const call = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = mcpAppTransport({ call, host: host() });
    for (const reply of [await transport.entries("c", {}), await transport.entry("c", "1"), await transport.total("c"), await transport.me()]) expect(reply).toEqual({ status: "unavailable" });
    expect(call).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is read-only and calls nothing when the host has no server tools", async () => {
    const call = vi.fn();
    const transport = mcpAppTransport({ call, host: host({}) });
    expect(transport.writable).toBe(false);
    expect(await transport.view("v", {}, {})).toEqual({ status: "unavailable" });
    expect(await transport.run("op", {})).toEqual({ status: "unavailable" });
    expect(call).not.toHaveBeenCalled();
    expect(mcpAppTransport({ host: host() }).writable).toBe(false);
  });

  it("reads AUTH_DENIED and NOT_FOUND as unavailable, any other failure as an error", async () => {
    const failure = (code: string) => result({ diagnostics: [{ code, message: `${code} happened` }] }, true);
    const transport = (answer: McpToolResult) => mcpAppTransport({ call: async () => answer, host: host() });
    expect(await transport(failure("AUTH_DENIED")).view("v", {}, {})).toEqual({ status: "unavailable" });
    expect(await transport(failure("NOT_FOUND")).run("op", {})).toEqual({ status: "unavailable" });
    await expect(transport(failure("INPUT_VALIDATION_FAILED")).view("v", {}, {})).rejects.toThrow("INPUT_VALIDATION_FAILED happened");
  });

  it("tells the model an operation ran, not what it returned, and only when it succeeded", async () => {
    const h = host();
    const ok = mcpAppTransport({ call: async () => result({ results: [[{ secret: 1 }]] }), host: h });
    expect(await ok.run("restock", { sku: "a" })).toEqual({ status: "ok", data: { results: [[{ secret: 1 }]] } });
    expect(h.updateModelContext).toHaveBeenCalledWith({ content: [{ type: "text", text: "Ran restock." }] });
    const refused = host();
    await mcpAppTransport({ call: async () => result({ diagnostics: [{ code: "AUTH_DENIED", message: "no" }] }, true), host: refused }).run("restock", {});
    expect(refused.updateModelContext).not.toHaveBeenCalled();
    // a host that refuses the note does not undo the write
    const failing = host();
    failing.updateModelContext.mockRejectedValue(new Error("no"));
    expect(await mcpAppTransport({ call: async () => result({}), host: failing }).run("restock", {})).toMatchObject({ status: "ok" });
  });
});

const meta: AdminMeta = { rowNames: { pending: { prioritylevel: "priorityLevel" } } };
const transportOf = (overrides: Partial<AdminTransport> = {}): AdminTransport => ({
  surface: "browser", host: null, writable: true,
  view: async () => ({ status: "ok", data: { rows: [{ id: "r1" }], nextCursor: "next" } }),
  entries: async () => ({ status: "ok", data: { items: [], nextCursor: undefined as never } }),
  entry: async () => ({ status: "unavailable" }),
  total: async () => ({ status: "ok", data: 3 }),
  me: async () => ({ status: "unavailable" }),
  run: async () => ({ status: "ok", data: { results: [] } }),
  ...overrides,
});

/** Renders `Probe` once; what its hooks returned is `seen`. */
function mount(client: QueryClient, transport: AdminTransport, probe: () => unknown): { seen: unknown } {
  const seen = { seen: undefined as unknown };
  function Probe(): null { seen.seen = probe(); return null; }
  renderToStaticMarkup(<QueryClientProvider client={client}><AdminHooksProvider meta={meta} transport={transport}><Probe /></AdminHooksProvider></QueryClientProvider>);
  return seen;
}

describe("data hooks", () => {
  it("run only inside <MantleAdmin>", () => {
    expect(() => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Reader /></QueryClientProvider>)).toThrow("inside <MantleAdmin>");
    function Reader(): null { useView("pending", {}); return null; }
  });

  it("key their queries under the prefixes Admin's own cache invalidation already covers", () => {
    const client = new QueryClient();
    mount(client, transportOf(), () => [useView("pending", { q: 1 }), useEntries("requests"), useEntry("requests", "1"), useCollectionTotal("requests"), useMe()]);
    expect(client.getQueryCache().getAll().map(query => query.queryKey[0]).sort()).toEqual(["collection-statistics", "entries", "entry-editor", "me", "view"]);
    client.clear();
  });

  it("read loading, ready and unavailable from the transport's reply", () => {
    const client = new QueryClient();
    const read = () => (mount(client, transportOf(), () => [useView("pending", {}), useEntry("requests", "1")]).seen as [{ rows: unknown[]; nextCursor?: string; status: string }, { entry: unknown; status: string }]);
    const [loading] = read();
    expect(loading).toEqual({ rows: [], nextCursor: undefined, status: "loading" });
    for (const query of client.getQueryCache().getAll()) client.setQueryData(query.queryKey, query.queryKey[0] === "view" ? { status: "ok", data: { rows: [{ id: "r1" }], nextCursor: "next" } } : { status: "unavailable" });
    const [view, entry] = read();
    expect(view).toEqual({ rows: [{ id: "r1" }], nextCursor: "next", status: "ready" });
    expect(entry).toEqual({ entry: undefined, status: "unavailable" });
    client.clear();
  });

  it("pass the View's row names and no caller to the transport, and refresh what Admin shows when an operation succeeds", async () => {
    const client = new QueryClient();
    for (const key of [["view", "pending", "x"], ["entries", "requests"], ["entry-editor", "requests", "1"], ["collection-statistics", "requests", "7d"], ["site"]]) client.setQueryData(key, 1);
    const run = vi.fn(async () => ({ status: "ok", data: { results: [] } }) as const);
    const state = mount(client, transportOf({ run }), () => useOperation("approve")).seen as { run: (input: object) => Promise<unknown>; pending: boolean };
    expect(await state.run({ id: "1" })).toEqual({ results: [] });
    expect(run).toHaveBeenCalledWith("approve", { id: "1" });
    const stale = client.getQueryCache().getAll().filter(query => query.state.isInvalidated).map(query => query.queryKey[0]).sort();
    expect(stale).toEqual(["collection-statistics", "entries", "entry-editor", "view"]);
    client.clear();
  });

  it("do not refresh anything when an operation fails, and read a refusal as unavailable", async () => {
    const client = new QueryClient();
    client.setQueryData(["view", "pending", "x"], 1);
    const unavailable = mount(client, transportOf({ run: async () => ({ status: "unavailable" }) }), () => useOperation("approve")).seen as { run: (input: object) => Promise<unknown> };
    await expect(unavailable.run({})).rejects.toBeInstanceOf(AdminUnavailableError);
    const failing = mount(client, transportOf({ run: async () => { throw new Error("boom"); } }), () => useOperation("approve")).seen as { run: (input: object) => Promise<unknown> };
    await expect(failing.run({})).rejects.toThrow("boom");
    expect(client.getQueryCache().find({ queryKey: ["view", "pending", "x"] })!.state.isInvalidated).toBe(false);
    client.clear();
  });

  it("give no run where the surface cannot write", () => {
    const state = mount(new QueryClient(), transportOf({ writable: false }), () => useOperation("approve")).seen as { run: unknown };
    expect(state.run).toBeUndefined();
  });

  it("tell the surface and the host", () => {
    expect(mount(new QueryClient(), transportOf(), () => [useAdminSurface(), useHost()]).seen).toEqual(["browser", null]);
    const h = host();
    expect(mount(new QueryClient(), mcpAppTransport({ host: h }), () => [useAdminSurface(), useHost()]).seen).toEqual(["mcp-app", h]);
  });
});
