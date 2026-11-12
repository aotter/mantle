import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";
import { outputOf, type CallTool, type ToolResult } from "../../../src/app/bridge.js";
import { APP_TOOLS, callAppTool, type ShownView } from "./app-tools";

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
  /**
   * `ui/download-file`: a CSV file saved to the person's device, named `name`, after the host confirms it. False when the
   * host offers no downloads, refuses or the person cancels; the host's answer does not tell these apart.
   */
  downloadFile(name: string, text: string): Promise<boolean>;
  /**
   * The App's own tools (`APP_TOOLS`), which the host calls for the model: `read` gives what the App shows while it is set;
   * without it each call answers that no View is shown.
   */
  serveTools(read: (() => ShownView | null) | undefined): void;
}

/** The display modes the App can lay itself out for. */
export const APP_DISPLAY_MODES: readonly McpUiDisplayMode[] = ["inline", "fullscreen"];
const MODES: readonly unknown[] = ["inline", "fullscreen", "pip"];

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function json(value: unknown): boolean {
  const active = new WeakSet<object>(),
    stack: [unknown, boolean][] = [[value, false]];
  while (stack.length) {
    const [item, leaving] = stack.pop()!;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (!Array.isArray(item) && (!record(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))))
      return false;
    const object = item as object;
    if (leaving) {
      active.delete(object);
      continue;
    }
    if (active.has(object)) return false;
    active.add(object);
    stack.push([object, true]);
    for (const [key, child] of Object.entries(object)) {
      if (key === "__proto__") return false;
      stack.push([child, false]);
    }
  }
  return true;
}

/** An absolute http(s) URL: the only links the App asks a host to open. */
export function web(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}
/** `McpUiStyleVariableKey`: the colors, fonts, radii, borders and shadows a host may set. */
const HOST_STYLE_VARIABLE =
  /^--(color-(background|text|border|ring)-[a-z]+|font-(sans|mono|weight-[a-z]+|(text|heading)-[a-z0-9]+-(size|line-height))|border-radius-[a-z]+|border-width-regular|shadow-[a-z]+)$/;
/** Validate what the controller consumes; ignored optional protocol metadata may be undefined. */
function result(value: unknown): value is ToolResult {
  if (
    !(
      record(value) &&
      Array.isArray(value.content) &&
      value.content.every(
        item =>
          record(item) &&
          typeof item.type === "string" &&
          (item.type === "text"
            ? typeof item.text === "string"
            : item.text === undefined || typeof item.text === "string"),
      ) &&
      (value.structuredContent === undefined || record(value.structuredContent)) &&
      (value._meta === undefined || record(value._meta)) &&
      (value.isError === undefined || typeof value.isError === "boolean")
    )
  )
    return false;
  const output = outputOf(value as ToolResult);
  return output === undefined || json(output);
}

export function connectHost(
  handlers: {
    ready(host: HostApi, context: McpUiHostContext): void;
    input(args: Record<string, unknown>): void;
    result(result: ToolResult): void;
    cancelled(): void;
    context(context: McpUiHostContext): void;
    error(error: Error): void;
  },
  win: Window = window,
  version = "0.0.0",
): () => void {
  // `tools`: the App's own view-only tools, a fixed list (no `listChanged`); a host without app tools never asks for them
  const app = new App(
    { name: "mantle", version },
    { availableDisplayModes: [...APP_DISPLAY_MODES], tools: {} },
    { autoResize: false },
  );
  let closed = false,
    ready = false;
  let shown: (() => ShownView | null) | undefined;
  app.onlisttools = async () => ({ tools: APP_TOOLS });
  app.oncalltool = ({ name, arguments: args }, extra) =>
    callAppTool(() => (closed ? null : (shown?.() ?? null)), name, args ?? {}, extra.mcpReq.signal);
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
  app.ontoolinput = ({ arguments: args }) => {
    if (active() && json(args ?? {})) handlers.input(args ?? {});
  };
  app.ontoolresult = value => {
    if (active() && result(value)) handlers.result(value);
  };
  app.ontoolcancelled = () => {
    if (active()) handlers.cancelled();
  };
  app.onhostcontextchanged = value => {
    if (active()) handlers.context(value);
  };
  app.onclose = () => {
    if (ready && !closed) {
      handlers.error(new Error("MCP host disconnected. Reopen the App to reconnect."));
      disconnect();
    }
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
  const target = {
    postMessage: (message: unknown) => win.parent.postMessage(message, origin && origin !== "null" ? origin : "*"),
  } as Window;
  void app
    .connect(new PostMessageTransport(target, win.parent))
    .then(() => {
      if (closed) return;
      origin = incomingOrigin;
      ready = true;
      const capabilities = app.getHostCapabilities() ?? {};
      const ask = async (request: () => Promise<unknown>) => {
        if (closed) return false;
        try {
          const answer = await request();
          return record(answer) && answer.isError !== true;
        } catch {
          return false;
        }
      };
      handlers.ready(
        {
          capabilities,
          ...(capabilities.serverTools ? { call } : {}),
          openLink: async url => !!capabilities.openLinks && web(url) && ask(() => app.openLink({ url })),
          sendMessage: async text =>
            !!capabilities.message?.text &&
            ask(() => app.sendMessage({ role: "user", content: [{ type: "text", text }] })),
          updateModelContext: async ({ content, structuredContent }) => {
            const accepts = capabilities.updateModelContext;
            const sent = {
              ...(content && accepts?.text && content.every(block => block.type === "text") ? { content } : {}),
              ...(structuredContent && accepts?.structuredContent ? { structuredContent } : {}),
            };
            return Object.keys(sent).length > 0 && json(sent) && ask(() => app.updateModelContext(sent));
          },
          // the person confirms in the host, so the wait is theirs, not the SDK's default request timeout
          downloadFile: async (name, text) =>
            !!capabilities.downloadFile &&
            ask(() =>
              app.downloadFile(
                { contents: [{ type: "resource", resource: { uri: "file:///" + name, mimeType: "text/csv", text } }] },
                { timeout: 600_000 },
              ),
            ),
          serveTools: read => {
            shown = read;
          },
          requestDisplayMode: async mode => {
            if (closed || !app.getHostContext()?.availableDisplayModes?.includes(mode)) return null;
            try {
              const result = await app.requestDisplayMode({ mode });
              return MODES.includes(result.mode) ? result.mode : null;
            } catch {
              return null;
            }
          },
        },
        app.getHostContext() ?? {},
      );
      stopResize = reportHeight(app, win);
    })
    .catch(error => {
      if (!closed) {
        handlers.error(
          new Error(
            `Unable to connect to the MCP host. Reopen the App to reconnect. ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        disconnect();
      }
    });
  function disconnect() {
    if (closed) return;
    closed = true;
    ready = false;
    win.removeEventListener("message", guard, true);
    stopResize?.();
    void app.close();
  }
  return disconnect;
}

/**
 * `ui/notifications/size-changed` with the content height only. The SDK's own observer also reports
 * `window.innerWidth`; a host that first mounts the frame wider than its screen would keep that width,
 * so the frame never shrinks (#1931). `width` is optional in the notification: the host owns it.
 */
function reportHeight(app: App, win: Window): () => void {
  const doc = win.document,
    root = doc.documentElement;
  let pending = false,
    last = 0;
  const measure = () => {
    if (pending) return;
    pending = true;
    win.requestAnimationFrame(() => {
      pending = false;
      // the SDK's measurement: the content's own height, not the frame's
      const height = root.style.height;
      root.style.height = "max-content";
      const next = Math.ceil(root.getBoundingClientRect().height);
      root.style.height = height;
      if (next !== last) {
        last = next;
        void app.sendSizeChanged({ height: next }).catch(() => {});
      }
    });
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(root);
  observer.observe(doc.body);
  return () => observer.disconnect();
}

export function applyHostContext(value: McpUiHostContext, doc: Document = document): void {
  const root = doc.documentElement;
  if (value.locale) root.lang = value.locale;
  // `.dark` too, so an application's `.dark {}` overrides apply in a host as in the browser
  if (value.theme) {
    root.dataset.theme = value.theme;
    root.style.colorScheme = value.theme;
    root.classList.toggle("dark", value.theme === "dark");
  }
  // only the spec's style variables: a host cannot reach the App's own tokens (its primary color)
  for (const [key, item] of Object.entries(value.styles?.variables ?? {}))
    if (typeof item === "string" && HOST_STYLE_VARIABLE.test(key)) root.style.setProperty(key, item);
  const insets = value.safeAreaInsets,
    box = value.containerDimensions as
      | Partial<Record<"height" | "maxHeight" | "width" | "maxWidth", number>>
      | undefined;
  if (insets) root.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  if (box) {
    root.style.height = box.height === undefined ? "" : `${box.height}px`;
    // the host's width is an upper bound; the frame's own width wins when the host reports a wider one (#1931)
    for (const key of ["width", "maxWidth"] as const)
      root.style[key] = box[key] === undefined ? "" : `min(${box[key]}px, 100%)`;
    // a bounded frame scrolls its content; the max-height also holds the measured size within a fixed height
    const bound = Math.min(box.height ?? Infinity, box.maxHeight ?? Infinity);
    root.style.maxHeight = bound === Infinity ? "" : `${bound}px`;
    root.style.overflow = bound === Infinity ? "" : "auto";
  }
  const fonts = value.styles?.css?.fonts;
  if (fonts !== undefined) {
    const style =
      doc.getElementById("mantle-host-fonts") ??
      doc.head.appendChild(Object.assign(doc.createElement("style"), { id: "mantle-host-fonts" }));
    style.textContent = fonts;
  }
}
