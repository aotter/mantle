import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallTool, ToolResult } from "./bridge.js";

// MCP Apps 2026-01-26: only the messages this App consumes. The official
// AppBridge remains the interoperability oracle in the browser host test.
const VERSION = "2026-01-26";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function json(value: unknown): boolean {
  const active = new WeakSet<object>(), stack: [unknown, boolean][] = [[value, false]];
  while (stack.length) {
    const [item, leaving] = stack.pop()!;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) return false; continue; }
    if (!Array.isArray(item) && (!record(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) return false;
    const object = item as object;
    if (leaving) { active.delete(object); continue; }
    if (active.has(object)) return false;
    active.add(object); stack.push([object, true]);
    for (const [key, child] of Object.entries(object)) { if (key === "__proto__") return false; stack.push([child, false]); }
  }
  return true;
}

function context(value: unknown): value is McpUiHostContext {
  if (!record(value)) return false;
  if (value.locale !== undefined && typeof value.locale !== "string") return false;
  if (value.theme !== undefined && value.theme !== "light" && value.theme !== "dark") return false;
  if (value.toolInfo !== undefined && (!record(value.toolInfo) || !record(value.toolInfo.tool) || typeof value.toolInfo.tool.name !== "string")) return false;
  if (value.styles !== undefined) {
    if (!record(value.styles)) return false;
    const { variables, css } = value.styles;
    if (variables !== undefined && (!record(variables) || Object.entries(variables).some(([key, item]) => !/^--[a-z0-9-]+$/.test(key) || typeof item !== "string"))) return false;
    if (css !== undefined && (!record(css) || (css.fonts !== undefined && typeof css.fonts !== "string"))) return false;
  }
  return true;
}

function result(value: unknown): value is ToolResult {
  return record(value) && Array.isArray(value.content)
    && value.content.every(item => record(item) && typeof item.type === "string" && (item.type === "text" ? typeof item.text === "string" : item.text === undefined || typeof item.text === "string"))
    && (value.structuredContent === undefined || record(value.structuredContent))
    && (value._meta === undefined || record(value._meta))
    && (value.isError === undefined || typeof value.isError === "boolean");
}

export function connectHost(handlers: {
  ready(call: CallTool, context: McpUiHostContext): void;
  input(args: Record<string, unknown>): void;
  result(result: ToolResult): void;
  cancelled(): void;
  context(context: McpUiHostContext): void;
  error(error: Error): void;
}, win: Window = window): () => void {
  const parent = win.parent;
  const nonce = crypto.randomUUID();
  let serial = 0, origin: string | undefined, ready = false, closed = false;
  let observer: ResizeObserver | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; clean(): void; progress(): void }>();
  const send = (message: Record<string, unknown>) => parent.postMessage({ jsonrpc: "2.0", ...message }, origin && origin !== "null" ? origin : "*");
  const notify = (method: string, params?: unknown) => send({ method, ...(params === undefined ? {} : { params }) });
  function request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (closed || signal?.aborted) return Promise.reject(signal?.reason ?? new Error("App disconnected"));
    const id = `${nonce}:${++serial}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const entry = pending.get(id);
        if (!entry) return;
        entry.clean();
        notify("notifications/cancelled", { requestId: id, reason: "Request cancelled" });
        reject(signal?.reason ?? new Error("Host request timed out"));
      };
      let timer = setTimeout(abort, 60_000);
      pending.set(id, { resolve, reject, clean() { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(id); }, progress() { clearTimeout(timer); timer = setTimeout(abort, 60_000); } });
      signal?.addEventListener("abort", abort, { once: true });
      const payload = method === "tools/call" ? { ...(params as Record<string, unknown>), _meta: { progressToken: id } } : params;
      try { send({ id, method, params: payload }); } catch (error) { pending.get(id)!.clean(); reject(error); }
    });
  }
  const call: CallTool = async (name, args, signal) => {
    if (!ready || typeof name !== "string" || !name || !json(args)) throw new Error("Invalid tool call");
    const answer = await request("tools/call", { name, arguments: args }, signal);
    if (!result(answer)) throw new Error("Invalid tool result");
    return answer;
  };
  const receive = (event: MessageEvent) => {
    if (closed || event.source !== parent || (origin !== undefined && event.origin !== origin)) return;
    const message: unknown = event.data;
    if (!record(message) || message.jsonrpc !== "2.0" || !json(message)) return;
    if (message.method === undefined && typeof message.id === "string") {
      const entry = pending.get(message.id);
      if (!entry || (Object.hasOwn(message, "result") === Object.hasOwn(message, "error"))) return;
      if (message.error !== undefined) {
        if (!record(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== "string") return;
        entry.clean(); entry.reject(new Error(message.error.message));
      } else {
        // Only a valid initialize reply may establish the host origin.
        if (!ready) {
          const value = message.result;
          if (!record(value) || value.protocolVersion !== VERSION || !record(value.hostCapabilities)
            || !record(value.hostInfo) || typeof value.hostInfo.name !== "string" || typeof value.hostInfo.version !== "string" || !context(value.hostContext)) {
            entry.clean(); entry.reject(new Error("Invalid host handshake")); return;
          }
          origin = event.origin;
        }
        entry.clean(); entry.resolve(message.result);
      }
      return;
    }
    if (!ready || typeof message.method !== "string") return;
    // The App exposes no tools. A host cannot route an incoming tools/call
    // into the server, or trick a notification into becoming a write.
    if (message.id !== undefined) {
      if (typeof message.id !== "string" && (typeof message.id !== "number" || !Number.isSafeInteger(message.id))) return;
      send({ id: message.id, ...(message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Method not found" } }) });
      return;
    }
    const params = message.params;
    if (!record(params)) return;
    switch (message.method) {
      case "notifications/progress":
        if (typeof params.progressToken === "string" && typeof params.progress === "number" && params.progress >= 0) pending.get(params.progressToken)?.progress(); break;
      case "ui/notifications/tool-input":
        if (params.arguments === undefined || record(params.arguments)) handlers.input(params.arguments ?? {}); break;
      case "ui/notifications/tool-result":
        if (result(params)) handlers.result(params); break;
      case "ui/notifications/tool-cancelled":
        if (params.reason === undefined || typeof params.reason === "string") handlers.cancelled(); break;
      case "ui/notifications/host-context-changed":
        if (context(params)) handlers.context(params); break;
    }
  };
  win.addEventListener("message", receive);
  void request("ui/initialize", { appInfo: { name: "mantle", version: "1.0.0" }, appCapabilities: {}, protocolVersion: VERSION }).then(answer => {
    if (closed) return;
    ready = true;
    handlers.ready(call, (answer as { hostContext: McpUiHostContext }).hostContext);
    notify("ui/notifications/initialized");
    let width = 0, height = 0, scheduled = false;
    const resize = () => {
      if (scheduled || closed) return;
      scheduled = true;
      win.requestAnimationFrame(() => {
        scheduled = false;
        if (closed) return;
        const root = win.document.documentElement, previous = root.style.height;
        root.style.height = "max-content";
        const nextHeight = Math.ceil(root.getBoundingClientRect().height), nextWidth = Math.ceil(win.innerWidth);
        root.style.height = previous;
        if (height !== nextHeight || width !== nextWidth) { height = nextHeight; width = nextWidth; notify("ui/notifications/size-changed", { width, height }); }
      });
    };
    observer = new ResizeObserver(resize);
    observer.observe(win.document.documentElement); observer.observe(win.document.body); resize();
  }).catch(error => { if (!closed) handlers.error(error instanceof Error ? error : new Error(String(error))); });
  return () => {
    closed = true; ready = false;
    win.removeEventListener("message", receive); observer?.disconnect();
    for (const entry of [...pending.values()]) { entry.clean(); entry.reject(new Error("App disconnected")); }
  };
}

export function applyHostContext(value: McpUiHostContext, doc: Document = document): void {
  const root = doc.documentElement;
  if (value.locale) root.lang = value.locale;
  if (value.theme) { root.dataset.theme = value.theme; root.style.colorScheme = value.theme; }
  for (const [key, item] of Object.entries(value.styles?.variables ?? {})) if (typeof item === "string") root.style.setProperty(key, item);
  const fonts = value.styles?.css?.fonts;
  if (fonts !== undefined) {
    const style = doc.getElementById("mantle-host-fonts") ?? doc.head.appendChild(Object.assign(doc.createElement("style"), { id: "mantle-host-fonts" }));
    style.textContent = fonts;
  }
}
