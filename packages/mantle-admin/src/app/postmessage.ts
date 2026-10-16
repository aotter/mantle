import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { McpUiDisplayMode, McpUiHostCapabilities, McpUiHostContext, McpUiUpdateModelContextRequest } from "@modelcontextprotocol/ext-apps";
import { outputOf, type CallTool, type ToolResult } from "./bridge.js";

/** What the host lets the App do beyond rendering; each request is sent only when the host advertised it. */
export interface HostApi {
  readonly capabilities: McpUiHostCapabilities;
  /** Server tool calls through the host; absent when the host offers no `serverTools`, so the App is read-only. */
  readonly call?: CallTool;
  /** `ui/open-link` for an http(s) URL; false when the host cannot open links or refuses. */
  openLink(url: string): Promise<boolean>;
  /** `ui/message`: a user message in the conversation. The App never sends one by itself. */
  sendMessage(text: string): Promise<boolean>;
  /** `ui/update-model-context`: what the model should know at its next turn, without starting one. */
  updateModelContext(params: McpUiUpdateModelContextRequest["params"]): Promise<boolean>;
  /** `ui/request-display-mode`: the mode the host granted, or null when it offers none other. */
  requestDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode | null>;
}

/** The display modes the App can lay itself out for. */
export const APP_DISPLAY_MODES: readonly McpUiDisplayMode[] = ["inline", "fullscreen"];
const MODES: readonly unknown[] = ["inline", "fullscreen", "pip"];

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

/** An absolute http(s) URL: the only links the App asks a host to open. */
export function web(url: string): boolean {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}
/** `McpUiStyleVariableKey`: the colors, fonts, radii, borders and shadows a host may set. */
const HOST_STYLE_VARIABLE = /^--(color-(background|text|border|ring)-[a-z]+|font-(sans|mono|weight-[a-z]+|(text|heading)-[a-z0-9]+-(size|line-height))|border-radius-[a-z]+|border-width-regular|shadow-[a-z]+)$/;
/** Validate what the controller consumes; ignored optional protocol metadata may be undefined. */
function result(value: unknown): value is ToolResult {
  if (!(record(value) && Array.isArray(value.content)
    && value.content.every(item => record(item) && typeof item.type === "string" && (item.type === "text" ? typeof item.text === "string" : item.text === undefined || typeof item.text === "string"))
    && (value.structuredContent === undefined || record(value.structuredContent))
    && (value._meta === undefined || record(value._meta))
    && (value.isError === undefined || typeof value.isError === "boolean"))) return false;
  const output = outputOf(value as ToolResult);
  return output === undefined || json(output);
}

export function connectHost(handlers: {
  ready(host: HostApi, context: McpUiHostContext): void;
  input(args: Record<string, unknown>): void;
  result(result: ToolResult): void;
  cancelled(): void;
  context(context: McpUiHostContext): void;
  error(error: Error): void;
}, win: Window = window, version = "0.0.0"): () => void {
  const app = new App({ name: "mantle", version }, { availableDisplayModes: [...APP_DISPLAY_MODES] }, { autoResize: false });
  let closed = false, ready = false;
  let stopResize: (() => void) | undefined;
  let origin: string | undefined, incomingOrigin: string | undefined;
  // The official transport checks the parent WindowProxy. Keep origin continuity as a
  // separate platform guard: only the official successful handshake pins the origin;
  // a parent that subsequently navigates cannot inherit this connection.
  // No message IDs, methods, envelopes or protocol versions are interpreted here.
  const guard = (event: MessageEvent) => {
    if (event.source !== win.parent) return;
    if (origin !== undefined && event.origin !== origin) event.stopImmediatePropagation();
    else incomingOrigin = event.origin;
  };
  win.addEventListener("message", guard, true);
  const active = () => !closed;
  app.ontoolinput = ({ arguments: args }) => { if (active() && json(args ?? {})) handlers.input(args ?? {}); };
  app.ontoolresult = value => { if (active() && result(value)) handlers.result(value); };
  app.ontoolcancelled = () => { if (active()) handlers.cancelled(); };
  app.onhostcontextchanged = value => { if (active()) handlers.context(value); };
  app.onclose = () => {
    if (ready && !closed) { handlers.error(new Error("MCP host disconnected. Reopen the App to reconnect.")); disconnect(); }
  };
  app.onteardown = () => {
    handlers.cancelled();
    // Let the official handler acknowledge teardown before closing its transport.
    win.setTimeout(disconnect, 0);
    return {};
  };
  const call: CallTool = async (name, args, signal) => {
    if (!ready || closed || !name || !json(args)) throw new Error("Invalid tool call");
    const answer = await app.callServerTool({ name, arguments: args }, { signal });
    if (!result(answer)) throw new Error("Invalid tool result");
    return answer;
  };
  // The official transport targets "*". Narrow delivery after the handshake too,
  // so a navigated parent cannot receive subsequent tool arguments or context.
  const target = { postMessage: (message: unknown) => win.parent.postMessage(message, origin && origin !== "null" ? origin : "*") } as Window;
  void app.connect(new PostMessageTransport(target, win.parent)).then(() => {
    if (closed) return;
    origin = incomingOrigin;
    ready = true;
    const capabilities = app.getHostCapabilities() ?? {};
    const ask = async (request: () => Promise<unknown>) => {
      if (closed) return false;
      try { const answer = await request(); return record(answer) && answer.isError !== true; } catch { return false; }
    };
    handlers.ready({
      capabilities,
      ...(capabilities.serverTools ? { call } : {}),
      openLink: async url => !!capabilities.openLinks && web(url) && ask(() => app.openLink({ url })),
      sendMessage: async text => !!capabilities.message?.text && ask(() => app.sendMessage({ role: "user", content: [{ type: "text", text }] })),
      updateModelContext: async ({ content, structuredContent }) => {
        const accepts = capabilities.updateModelContext;
        const sent = {
          ...(content && accepts?.text && content.every(block => block.type === "text") ? { content } : {}),
          ...(structuredContent && accepts?.structuredContent ? { structuredContent } : {}),
        };
        return Object.keys(sent).length > 0 && json(sent) && ask(() => app.updateModelContext(sent));
      },
      requestDisplayMode: async mode => {
        if (closed || !app.getHostContext()?.availableDisplayModes?.includes(mode)) return null;
        try { const result = await app.requestDisplayMode({ mode }); return MODES.includes(result.mode) ? result.mode : null; } catch { return null; }
      },
    }, app.getHostContext() ?? {});
    stopResize = app.setupSizeChangedNotifications();
  }).catch(error => {
    if (!closed) { handlers.error(new Error(`Unable to connect to the MCP host. Reopen the App to reconnect. ${error instanceof Error ? error.message : String(error)}`)); disconnect(); }
  });
  function disconnect() {
    if (closed) return;
    closed = true; ready = false;
    win.removeEventListener("message", guard, true);
    stopResize?.();
    void app.close();
  }
  return disconnect;
}

export function applyHostContext(value: McpUiHostContext, doc: Document = document): void {
  const root = doc.documentElement;
  if (value.locale) root.lang = value.locale;
  // `.dark` too, so an application's `.dark {}` overrides apply in a host as in the browser
  if (value.theme) { root.dataset.theme = value.theme; root.style.colorScheme = value.theme; root.classList.toggle("dark", value.theme === "dark"); }
  // only the spec's style variables: a host cannot reach the App's own tokens (its primary color)
  for (const [key, item] of Object.entries(value.styles?.variables ?? {})) if (typeof item === "string" && HOST_STYLE_VARIABLE.test(key)) root.style.setProperty(key, item);
  const insets = value.safeAreaInsets, box = value.containerDimensions as Partial<Record<"height" | "maxHeight" | "width" | "maxWidth", number>> | undefined;
  if (insets) root.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  if (box) {
    for (const key of ["height", "width", "maxWidth"] as const) root.style[key] = box[key] === undefined ? "" : `${box[key]}px`;
    // a bounded frame scrolls its content; the max-height also holds the measured size within a fixed height
    const bound = Math.min(box.height ?? Infinity, box.maxHeight ?? Infinity);
    root.style.maxHeight = bound === Infinity ? "" : `${bound}px`;
    root.style.overflow = bound === Infinity ? "" : "auto";
  }
  const fonts = value.styles?.css?.fonts;
  if (fonts !== undefined) {
    const style = doc.getElementById("mantle-host-fonts") ?? doc.head.appendChild(Object.assign(doc.createElement("style"), { id: "mantle-host-fonts" }));
    style.textContent = fonts;
  }
}
