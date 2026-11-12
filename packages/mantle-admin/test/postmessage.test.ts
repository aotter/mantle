import { expect, test, vi } from "vitest";
import { applyHostContext, connectHost, type HostApi } from "../admin/src/mcp-app/postmessage";

// Adapter semantics only. The browser suite exercises these calls against the real
// official App/AppBridge pair, not a second implementation of their wire protocol.
const sdk = vi.hoisted(() => ({ apps: [] as any[] }));
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    capabilities: Record<string, unknown> = {};
    context: Record<string, unknown> = {};
    connected: Promise<void>;
    resolve!: () => void;
    reject!: (error: Error) => void;
    callServerTool = vi.fn(async () => ({ content: [] }));
    openLink = vi.fn(async () => ({}));
    sendMessage = vi.fn(async () => ({}));
    updateModelContext = vi.fn(async () => ({}));
    requestDisplayMode = vi.fn(async ({ mode }: { mode: string }) => ({ mode }));
    downloadFile = vi.fn(async () => ({}));
    sendToolListChanged = vi.fn(async () => {});
    sendSizeChanged = vi.fn(async () => {});
    close = vi.fn(async () => {});
    constructor(
      readonly info: unknown,
      readonly appCapabilities: unknown,
      readonly options: unknown,
    ) {
      this.connected = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
      sdk.apps.push(this);
    }
    connect = vi.fn(() => this.connected);
    getHostCapabilities() {
      return this.capabilities;
    }
    getHostContext() {
      return this.context;
    }
  },
  PostMessageTransport: class {
    constructor(
      readonly target: unknown,
      readonly source: unknown,
    ) {}
  },
}));
// the content-height observer: one per connection, disconnected with it
const observers = vi.hoisted(() => [] as { observed: unknown[]; disconnect: ReturnType<typeof vi.fn> }[]);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observed: unknown[] = [];
    disconnect = vi.fn();
    constructor() {
      observers.push(this);
    }
    observe(node: unknown) {
      this.observed.push(node);
    }
  },
);
const make = async (capabilities = {}, context = {}, initialize = true) => {
  const ready = vi.fn(),
    input = vi.fn(),
    result = vi.fn(),
    cancelled = vi.fn(),
    changed = vi.fn(),
    error = vi.fn();
  const root = { style: { height: "" }, getBoundingClientRect: () => ({ height: 412.2 }) },
    body = {};
  const win = {
    parent: { postMessage: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    document: { documentElement: root, body },
    requestAnimationFrame: (run: () => void) => {
      run();
      return 0;
    },
  } as unknown as Window;
  const disconnect = connectHost({ ready, input, result, cancelled, context: changed, error }, win, "9.9.9");
  const app = sdk.apps.at(-1)!;
  app.capabilities = capabilities;
  app.context = context;
  if (initialize) {
    const guard = vi.mocked(win.addEventListener).mock.calls[0]![1] as (event: MessageEvent) => void;
    guard({ source: win.parent, origin: "https://host.test", data: {} } as MessageEvent);
    app.resolve();
    await Promise.resolve();
  }
  return {
    app,
    ready,
    input,
    result,
    cancelled,
    changed,
    error,
    win,
    disconnect,
    host: ready.mock.calls[0]?.[0] as HostApi,
  };
};

test("official App owns initialization, with package version, supported layouts and a height-only size report", async () => {
  const { app, win, disconnect } = await make();
  expect(app.info).toEqual({ name: "mantle", version: "9.9.9" });
  expect(app.appCapabilities).toEqual({
    availableDisplayModes: ["inline", "fullscreen"],
    tools: { listChanged: true },
  });
  const transport = app.connect.mock.calls[0][0];
  expect(transport.source).toBe(win.parent);
  transport.target.postMessage({ hello: "host" }, "*");
  expect(win.parent.postMessage).toHaveBeenCalledWith({ hello: "host" }, "https://host.test");
  // the content height, never the frame's width: the host owns the width (#1931)
  expect(app.sendSizeChanged.mock.calls).toEqual([[{ height: 413 }]]);
  const observer = observers.at(-1)!;
  expect(observer.observed).toEqual([win.document.documentElement, win.document.body]);
  disconnect();
  disconnect();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  expect(app.close).toHaveBeenCalledOnce();
  expect(win.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function), true);
});

test("missing capabilities expose no tool call and send no unavailable host requests", async () => {
  const { host, app, disconnect } = await make();
  expect(host.call).toBeUndefined();
  expect(await host.openLink("https://example.com")).toBe(false);
  expect(await host.sendMessage("hi")).toBe("refused");
  expect(await host.updateModelContext({ content: [{ type: "text", text: "x" }] })).toBe(false);
  expect(await host.requestDisplayMode("fullscreen")).toBeNull();
  expect(await host.downloadFile("pending.csv", "id\r\n")).toBe("refused");
  for (const request of [
    app.callServerTool,
    app.openLink,
    app.sendMessage,
    app.updateModelContext,
    app.requestDisplayMode,
    app.downloadFile,
  ])
    expect(request).not.toHaveBeenCalled();
  disconnect();
});

test("host calls use official methods, retain abort signals and limit links and model context", async () => {
  const { app, host, disconnect } = await make(
    { serverTools: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {} } },
    { availableDisplayModes: ["inline", "fullscreen"] },
  );
  const abort = new AbortController();
  await host.call!("review", { id: "r1" }, abort.signal);
  expect(app.callServerTool).toHaveBeenCalledWith(
    { name: "review", arguments: { id: "r1" } },
    { signal: abort.signal },
  );
  expect(await host.openLink("javascript:alert(1)")).toBe(false);
  expect(await host.openLink("/relative")).toBe(false);
  expect(await host.openLink("https://example.com")).toBe(true);
  expect(app.openLink).toHaveBeenCalledWith({ url: "https://example.com" });
  app.openLink.mockResolvedValueOnce({ isError: true });
  expect(await host.openLink("https://example.com")).toBe(false);
  // links and model context stay yes/no: no answer in time is false
  app.openLink.mockRejectedValueOnce(new Error("Request timed out"));
  expect(await host.openLink("https://example.com")).toBe(false);
  app.updateModelContext.mockRejectedValueOnce(new Error("Request timed out"));
  expect(await host.updateModelContext({ content: [{ type: "text", text: "late" }] })).toBe(false);
  expect(await host.sendMessage("hi")).toBe("accepted");
  expect(app.sendMessage).toHaveBeenCalledWith({ role: "user", content: [{ type: "text", text: "hi" }] });
  expect(await host.updateModelContext({ structuredContent: { secret: 1 } })).toBe(false);
  expect(
    await host.updateModelContext({ content: [{ type: "text", text: "done" }], structuredContent: { omitted: 1 } }),
  ).toBe(true);
  expect(app.updateModelContext).toHaveBeenCalledWith({ content: [{ type: "text", text: "done" }] });
  expect(await host.requestDisplayMode("fullscreen")).toBe("fullscreen");
  disconnect();
  await expect(host.call!("review", {})).rejects.toThrow("Invalid tool call");
  expect(await host.sendMessage("closed")).toBe("refused");
});

// The person may confirm in the host: an answer without an error is not delivery, and no answer is not a failure.
test.each(["sendMessage", "downloadFile"] as const)(
  "%s: an error answer is refused, a timeout, a thrown error or a connection lost in flight is unknown",
  async method => {
    const { app, host, disconnect } = await make({ message: { text: {} }, downloadFile: {} });
    const send = () => (method === "sendMessage" ? host.sendMessage("hi") : host.downloadFile("pending.csv", "x"));
    expect(await send()).toBe("accepted");
    app[method].mockResolvedValueOnce({ isError: true });
    expect(await send()).toBe("refused");
    app[method].mockResolvedValueOnce({ isError: false });
    expect(await send()).toBe("accepted");
    app[method].mockRejectedValueOnce(Object.assign(new Error("Request timed out"), { code: -32001 }));
    expect(await send()).toBe("unknown");
    app[method].mockRejectedValueOnce(new Error("Method not found"));
    expect(await send()).toBe("unknown");
    // the official client rejects a request still in flight when its connection closes
    let lose!: (error: Error) => void;
    app[method].mockReturnValueOnce(new Promise((_, reject) => (lose = reject)));
    const inFlight = send();
    disconnect();
    lose(Object.assign(new Error("Connection closed"), { code: -32000 }));
    expect(await inFlight).toBe("unknown");
    // once closed nothing is sent
    expect(await send()).toBe("refused");
    expect(app[method]).toHaveBeenCalledTimes(6);
  },
);

test("a download is one embedded text resource named by its file:// URI, with the person's time to confirm", async () => {
  const { app, host, disconnect } = await make({ downloadFile: {} });
  expect(await host.downloadFile("pending.csv", "\uFEFFitem\r\nLaptops\r\n", "text/csv")).toBe("accepted");
  expect(app.downloadFile.mock.calls).toEqual([
    [
      {
        contents: [
          {
            type: "resource",
            resource: { uri: "file:///pending.csv", mimeType: "text/csv", text: "\uFEFFitem\r\nLaptops\r\n" },
          },
        ],
      },
      { timeout: 600_000 },
    ],
  ]);
  // a page's file is plain text unless it names a type
  expect(await host.downloadFile("notes.txt", "hi")).toBe("accepted");
  expect(app.downloadFile.mock.calls[1]![0].contents[0].resource).toEqual({
    uri: "file:///notes.txt",
    mimeType: "text/plain",
    text: "hi",
  });
  // the URI's last segment is the saved name: a name with a path, or none, is not sent
  expect(await host.downloadFile("a/b.txt", "x")).toBe("refused");
  expect(await host.downloadFile("", "x")).toBe("refused");
  // a refusal and a cancellation are the same answer
  app.downloadFile.mockResolvedValueOnce({ isError: true });
  expect(await host.downloadFile("pending.csv", "x")).toBe("refused");
  disconnect();
  expect(await host.downloadFile("pending.csv", "x")).toBe("refused");
  expect(app.downloadFile).toHaveBeenCalledTimes(3);
});

test("the App's own tools: the same definitions on every mount, answered from what the App shows, none once closed", async () => {
  const first = await make({ serverTools: {} }),
    second = await make();
  const extra = { mcpReq: { signal: new AbortController().signal } };
  const listed = await first.app.onlisttools({}, extra);
  expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(["view_state", "view_more", "view_focus"]);
  expect(JSON.stringify(await second.app.onlisttools({}, extra))).toBe(JSON.stringify(listed));
  const call = (state: typeof first) => state.app.oncalltool({ name: "view_state", arguments: {} }, extra);
  expect(await call(first)).toMatchObject({ isError: true });
  const focus = vi.fn(() => true);
  first.host.serveTools(() => ({
    tool: "pending",
    input: {},
    rows: [{ id: "r1" }],
    cursor: undefined,
    loading: false,
    generation: 1,
    focus,
  }));
  expect(JSON.parse((await call(first)).content[0].text)).toMatchObject({ tool: "pending", ids: ["r1"] });
  first.host.serveTools(undefined);
  expect(await call(first)).toMatchObject({ isError: true });
  first.host.serveTools(() => ({
    tool: "p",
    input: {},
    rows: [],
    cursor: undefined,
    loading: false,
    generation: 1,
    focus,
  }));
  first.disconnect();
  expect(await call(first)).toMatchObject({ isError: true });
  // answering the model's tools sends the host nothing of the App's own
  expect(first.app.callServerTool).not.toHaveBeenCalled();
  second.disconnect();
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const note = (handler = vi.fn((args: Readonly<Record<string, unknown>>) => `noted ${String(args["text"])}`)) => ({
  name: "page_note",
  title: "Add a note",
  description: "Adds a note to the open page.",
  inputSchema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] },
  handler,
});

test("a page's tools: listed after the App's own while registered, replaced, removed, and the host told of each change", async () => {
  const { app, host, disconnect } = await make({ serverTools: {} });
  const extra = { mcpReq: { signal: new AbortController().signal } };
  const names = async () => (await app.onlisttools({}, extra)).tools.map((tool: { name: string }) => tool.name);
  const call = (name: string, args: unknown = { text: "a" }) => app.oncalltool({ name, arguments: args }, extra);
  const first = note();
  const remove = host.registerTools([first]);
  expect(await names()).toEqual(["view_state", "view_more", "view_focus", "page_note"]);
  // the definition as the host reads it: no handler
  expect((await app.onlisttools({}, extra)).tools[3]).toEqual({
    name: "page_note",
    title: "Add a note",
    description: "Adds a note to the open page.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  });
  await tick();
  expect(app.sendToolListChanged).toHaveBeenCalledTimes(1);
  expect(await call("page_note")).toEqual({ content: [{ type: "text", text: "noted a" }] });
  expect(first.handler).toHaveBeenCalledWith({ text: "a" }, extra.mcpReq.signal);
  // a re-render: the effect's cleanup and a new registration of the same definitions in one task tell the host nothing
  const second = note();
  remove();
  const removeSecond = host.registerTools([second]);
  await tick();
  expect(app.sendToolListChanged).toHaveBeenCalledTimes(1);
  await call("page_note");
  expect(first.handler).toHaveBeenCalledOnce();
  expect(second.handler).toHaveBeenCalledOnce();
  // a replacement: the earlier registration's cleanup no longer removes anything
  const removeThird = host.registerTools([{ ...note(), name: "page_other" }]);
  removeSecond();
  expect(await names()).toEqual(["view_state", "view_more", "view_focus", "page_other"]);
  expect(await call("page_note")).toMatchObject({ isError: true, content: [{ text: "Unknown tool: page_note" }] });
  await tick();
  expect(app.sendToolListChanged).toHaveBeenCalledTimes(2);
  // unmounted: the App's own tools only, and the handler is never called again
  removeThird();
  expect(await names()).toEqual(["view_state", "view_more", "view_focus"]);
  expect(await call("page_other")).toMatchObject({ isError: true });
  await tick();
  expect(app.sendToolListChanged).toHaveBeenCalledTimes(3);
  // closed: nothing is called or announced
  const last = note();
  host.registerTools([last]);
  disconnect();
  expect(await call("page_note")).toMatchObject({ isError: true });
  expect(last.handler).not.toHaveBeenCalled();
  await tick();
  expect(app.sendToolListChanged).toHaveBeenCalledTimes(3);
});

test("a page tool's throw or non-text answer is an error result; a lost announcement is not the page's error", async () => {
  const { app, host, disconnect } = await make();
  const extra = { mcpReq: { signal: new AbortController().signal } };
  app.sendToolListChanged.mockRejectedValueOnce(new Error("Not connected"));
  host.registerTools([
    note(
      vi.fn(() => {
        throw new Error("No such row.");
      }),
    ),
    { ...note(vi.fn(async () => 1 as unknown as string)), name: "page_count" },
    { ...note(vi.fn(async () => Promise.reject("gone"))), name: "page_gone" },
  ]);
  const call = (name: string) => app.oncalltool({ name, arguments: {} }, extra);
  expect(await call("page_note")).toEqual({ content: [{ type: "text", text: "No such row." }], isError: true });
  expect(await call("page_count")).toEqual({
    content: [{ type: "text", text: "page_count answered no text." }],
    isError: true,
  });
  expect(await call("page_gone")).toEqual({ content: [{ type: "text", text: "gone" }], isError: true });
  await tick();
  disconnect();
});

test("a page's tools that a host would reject are refused when registered, and the registered ones stay", async () => {
  const { app, host, disconnect } = await make();
  const extra = { mcpReq: { signal: new AbortController().signal } };
  host.registerTools([note()]);
  const refused = (tools: object[]) => () => host.registerTools(tools as never);
  expect(refused([{ ...note(), name: "view_state" }])).toThrow('"view_" names are the App\'s own tools');
  expect(refused([{ ...note(), name: "view_page" }])).toThrow("view_");
  expect(refused([note(), note()])).toThrow("registered twice");
  expect(refused([{ ...note(), name: "has space" }])).toThrow("letters, digits");
  expect(refused([{ ...note(), name: "x".repeat(129) }])).toThrow("letters, digits");
  expect(refused([{ ...note(), inputSchema: { type: "string" } }])).toThrow('type "object"');
  expect(refused([{ ...note(), inputSchema: undefined }])).toThrow('type "object"');
  expect(refused([{ ...note(), inputSchema: { type: "object", description: "x".repeat(64 * 1024) } }])).toThrow(
    "64 KiB",
  );
  let deep: Record<string, unknown> = { type: "string" };
  for (let level = 0; level < 32; level++) deep = { type: "object", properties: { a: deep } };
  expect(refused([{ ...note(), inputSchema: deep }])).toThrow("32 levels");
  const many = (count: number, extra = {}) =>
    Array.from({ length: count }, (_, i) => ({ ...note(), name: `page_${i}`, ...extra }));
  expect(() => host.registerTools(many(61))).not.toThrow();
  expect(refused(many(62))).toThrow("at most 61");
  expect(refused(many(30, { description: "x".repeat(40 * 1024) }))).toThrow("1 MiB");
  // the 61 registered before the refusals are still listed: with the App's own, a host's 64
  expect((await app.onlisttools({}, extra)).tools).toHaveLength(64);
  disconnect();
});

test("early and late results, cancellation, context and teardown keep their existing semantics", async () => {
  const state = await make({ serverTools: {} }, {}, false);
  state.app.ontoolinput({ arguments: { limit: 1 } });
  state.app.ontoolresult({ content: [], structuredContent: { rows: [] } });
  expect(state.input).toHaveBeenCalledWith({ limit: 1 });
  expect(state.result).toHaveBeenCalledOnce();
  state.app.resolve();
  await Promise.resolve();
  state.app.ontoolcancelled({ reason: "cancelled" });
  state.app.onhostcontextchanged({ theme: "dark" });
  expect(state.cancelled).toHaveBeenCalledOnce();
  expect(state.changed).toHaveBeenCalledWith({ theme: "dark" });
  expect(state.app.onteardown()).toEqual({});
  await new Promise(resolve => setTimeout(resolve, 1));
  expect(state.app.close).toHaveBeenCalledOnce();
  state.app.ontoolresult({ content: [] });
  expect(state.result).toHaveBeenCalledOnce();
});

test("unmount during initialization suppresses late ready/error; a fresh mount reconnects", async () => {
  const state = await make({}, {}, false);
  state.disconnect();
  state.app.resolve();
  await Promise.resolve();
  expect(state.ready).not.toHaveBeenCalled();
  expect(state.error).not.toHaveBeenCalled();
  expect(state.app.sendSizeChanged).not.toHaveBeenCalled();
  const fresh = await make();
  expect(fresh.ready).toHaveBeenCalledOnce();
  fresh.disconnect();
  const failed = await make({}, {}, false);
  failed.app.reject(new Error("host unavailable"));
  await Promise.resolve();
  await Promise.resolve();
  expect(failed.error.mock.calls[0][0].message).toContain("host unavailable");
  failed.disconnect();
});

test("result notifications and calls validate consumed data, not ignored optional protocol fields", async () => {
  const state = await make({ serverTools: {} });
  for (const value of [
    { content: [], structuredContent: { rows: [] }, _meta: undefined },
    { content: [{ type: "text", text: '{"rows":[]}', annotations: undefined }] },
  ]) {
    state.app.ontoolresult(value);
    expect(state.result).toHaveBeenLastCalledWith(value);
    state.app.callServerTool.mockResolvedValueOnce(value);
    await expect(state.host.call!("view", {})).resolves.toEqual(value);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [
    { content: [], structuredContent: cyclic },
    { content: [], structuredContent: JSON.parse('{"rows":[{"__proto__":{"unsafe":true}}]}') },
    { content: [{ type: "text", text: '{"rows":[{"__proto__":{"unsafe":true}}]}' }] },
  ]) {
    state.app.ontoolresult(value);
    state.app.callServerTool.mockResolvedValueOnce(value);
    await expect(state.host.call!("view", {})).rejects.toThrow("Invalid tool result");
  }
  expect(state.result).toHaveBeenCalledTimes(2);
  state.disconnect();
});

test("platform origin continuity guard is separate from the official source-window check", async () => {
  const { win, disconnect } = await make();
  const guard = vi.mocked(win.addEventListener).mock.calls[0]![1] as (event: MessageEvent) => void;
  const event = (source: unknown, origin: string) => ({ source, origin, data: {}, stopImmediatePropagation: vi.fn() });
  const unrelated = event({}, "https://attacker.test");
  guard(unrelated as unknown as MessageEvent);
  const first = event(win.parent, "https://host.test");
  guard(first as unknown as MessageEvent);
  const navigated = event(win.parent, "https://attacker.test");
  guard(navigated as unknown as MessageEvent);
  expect(first.stopImmediatePropagation).not.toHaveBeenCalled();
  expect(navigated.stopImmediatePropagation).toHaveBeenCalledOnce();
  disconnect();
});

test("applyHostContext: dark as both .dark and data-theme, only spec style variables, insets and the container's bounds", () => {
  const properties = new Map<string, string>(),
    classes = new Set<string>();
  const style: Record<string, unknown> = { setProperty: (key: string, value: string) => properties.set(key, value) };
  const root = {
    dataset: {} as Record<string, string>,
    style,
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
  };
  const doc = { documentElement: root } as unknown as Document;
  applyHostContext(
    {
      theme: "dark",
      displayMode: "fullscreen",
      safeAreaInsets: { top: 10, right: 1, bottom: 20, left: 2 },
      containerDimensions: { maxHeight: 400, width: 320 },
      styles: {
        variables: {
          "--color-background-primary": "#000",
          "--border-radius-md": "4px",
          "--font-text-sm-size": "13px",
          "--font-weight-medium": "550",
          "--mantle-app-primary": "red",
          "--color-primary": "red",
        } as never,
      },
    },
    doc,
  );
  expect(root.dataset).toEqual({ theme: "dark" });
  expect([...classes]).toEqual(["dark"]);
  expect(Object.fromEntries(properties)).toEqual({
    "--color-background-primary": "#000",
    "--border-radius-md": "4px",
    "--font-text-sm-size": "13px",
    "--font-weight-medium": "550",
  });
  expect(style).toMatchObject({
    padding: "10px 1px 20px 2px",
    maxHeight: "400px",
    width: "min(320px, 100%)",
    height: "",
    maxWidth: "",
    overflow: "auto",
  });
  applyHostContext({ theme: "light" }, doc);
  expect([...classes]).toEqual([]);
  // a fixed height is also the measured size's bound
  applyHostContext({ containerDimensions: { height: 300 } }, doc);
  expect(style).toMatchObject({ height: "300px", maxHeight: "300px", overflow: "auto" });
});
