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
  expect(app.appCapabilities).toEqual({ availableDisplayModes: ["inline", "fullscreen"], tools: {} });
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
  expect(await host.sendMessage("hi")).toBe(false);
  expect(await host.updateModelContext({ content: [{ type: "text", text: "x" }] })).toBe(false);
  expect(await host.requestDisplayMode("fullscreen")).toBeNull();
  expect(await host.downloadFile("pending.csv", "id\r\n")).toBe(false);
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
  expect(await host.sendMessage("hi")).toBe(true);
  expect(app.sendMessage).toHaveBeenCalledWith({ role: "user", content: [{ type: "text", text: "hi" }] });
  expect(await host.updateModelContext({ structuredContent: { secret: 1 } })).toBe(false);
  expect(
    await host.updateModelContext({ content: [{ type: "text", text: "done" }], structuredContent: { omitted: 1 } }),
  ).toBe(true);
  expect(app.updateModelContext).toHaveBeenCalledWith({ content: [{ type: "text", text: "done" }] });
  expect(await host.requestDisplayMode("fullscreen")).toBe("fullscreen");
  disconnect();
  await expect(host.call!("review", {})).rejects.toThrow("Invalid tool call");
  expect(await host.sendMessage("closed")).toBe(false);
});

test("a download is one embedded CSV resource named by its file:// URI, with the person's time to confirm", async () => {
  const { app, host, disconnect } = await make({ downloadFile: {} });
  expect(await host.downloadFile("pending.csv", "\uFEFFitem\r\nLaptops\r\n")).toBe(true);
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
  // a refusal and a cancellation are the same answer
  app.downloadFile.mockResolvedValueOnce({ isError: true });
  expect(await host.downloadFile("pending.csv", "x")).toBe(false);
  app.downloadFile.mockRejectedValueOnce(new Error("Request timed out"));
  expect(await host.downloadFile("pending.csv", "x")).toBe(false);
  disconnect();
  expect(await host.downloadFile("pending.csv", "x")).toBe(false);
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
    more: false,
    loading: false,
    generation: 1,
    focus,
  }));
  expect(JSON.parse((await call(first)).content[0].text)).toMatchObject({ tool: "pending", ids: ["r1"] });
  first.host.serveTools(undefined);
  expect(await call(first)).toMatchObject({ isError: true });
  first.host.serveTools(() => ({ tool: "p", input: {}, rows: [], more: false, loading: false, generation: 1, focus }));
  first.disconnect();
  expect(await call(first)).toMatchObject({ isError: true });
  // answering the model's tools sends the host nothing of the App's own
  expect(first.app.callServerTool).not.toHaveBeenCalled();
  second.disconnect();
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
