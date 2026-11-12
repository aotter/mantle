import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type {
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps";
import { outputOf, type CallTool, type ToolResult } from "../../../src/app/bridge.js";
import type { AdminAppTool, HostRequestOutcome } from "../app/hooks";
import { APP_TOOLS, callAppTool, callPageTool, pageToolList, type AppTool, type ShownView } from "./app-tools";

/** What the host lets the App do beyond rendering; each request is sent only when the host advertised it. */
export interface HostApi {
  readonly capabilities: McpUiHostCapabilities;
  /** Server tool calls through the host; absent when the host offers no `serverTools`, so the App is read-only. */
  readonly call?: CallTool;
  /**
   * `ui/open-link` for an http(s) URL; false when the host cannot open links, refuses, or did not answer in time (a link
   * the person confirms late can still open).
   */
  openLink(url: string): Promise<boolean>;
  /**
   * `ui/message`: a user message in the conversation, as `HostRequestOutcome`. The App never sends one by itself. The text
   * goes through `messageText`; one it refuses (blank, too long) is `refused` without asking the host.
   */
  sendMessage(text: string): Promise<HostRequestOutcome>;
  /** `ui/update-model-context`: what the model should know at its next turn, without starting one. */
  updateModelContext(params: McpUiUpdateModelContextRequest["params"]): Promise<boolean>;
  /**
   * `ui/request-display-mode`: the mode the host set, which is the App's current mode when it refuses (compare it with
   * the mode asked for), or null when the host does not list `mode` in `availableDisplayModes` or no valid answer came.
   * Call it directly in a click or key handler, while the App has focus: Claude refuses `fullscreen` without a recent
   * click or key press in the view.
   */
  requestDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode | null>;
  /**
   * `ui/download-file`: a text file saved to the person's device, named `downloadName(name)`, after the person confirms it
   * in the host. `refused` when the host offers no downloads, refuses or the person cancels (its answer does not tell these
   * apart), or `name` names no file; `unknown` when no answer came, and the host's dialog may still save the file.
   */
  downloadFile(name: string, text: string, mimeType?: string): Promise<HostRequestOutcome>;
  /**
   * The App's own tools (`APP_TOOLS`), which the host calls for the model: `read` gives what the App shows while it is set;
   * without it each call answers that no View is shown.
   */
  serveTools(read: (() => ShownView | null) | undefined): void;
  /** `AdminHost.registerTools`: a page's tools, listed after `APP_TOOLS` and earlier registrations while registered. */
  registerTools(tools: readonly AdminAppTool[]): () => void;
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

/** The most characters a `ui/message` may carry (Claude: 8,000). */
export const MESSAGE_LIMIT = 8_000;
/**
 * Invisible characters with no part in an emoji or a writing system: soft hyphen, zero-width space, word joiner, the
 * invisible math operators and the zero-width no-break space. Zero-width (non-)joiners, variation selectors and
 * direction marks stay: Claude accepts them where an emoji or a script uses them, and dropping one could change the text.
 */
const INVISIBLE = /[\u00AD\u200B\u2060-\u2064\uFEFF]/g;
/** A character a person sees: not whitespace, a joiner, a variation selector or a direction mark kept above. */
const VISIBLE = /[^\s\u200C-\u200F\uFE00-\uFE0F]/;

/**
 * A `ui/message` text within what Claude documents it accepts (claude.com/docs/connectors/building/mcp-apps/send-messages),
 * or null when it cannot be. What carries no meaning is normalised: invisible characters are dropped, runs of more than
 * three line breaks (`\r\n` counts as one) become three, runs of more than 64 spaces or tabs become 64. What would
 * change the message is refused, not repaired: a blank text (only whitespace, joiners, variation selectors or direction
 * marks), or one over `MESSAGE_LIMIT` characters (counted in UTF-16 units, never fewer than a host counts) after that
 * normalising, since cutting it would send the person's words only in part.
 */
export function messageText(text: string): string | null {
  const sent = text
    .replace(INVISIBLE, "")
    .replace(/(?:\r\n|\r(?!\n)|\n){4,}/g, "\n\n\n")
    .replace(/[ \t]{65,}/g, run => run.slice(0, 64));
  return VISIBLE.test(sent) && sent.length <= MESSAGE_LIMIT ? sent : null;
}

/**
 * A download's file name as the last segment of its `file:///` URI, the segment a host saves it as, or null. Characters
 * that would end or change that segment (`/`, `?`, `#`) and those Claude replaces with `_` anyway (`%`, `:`, `"`, `*`,
 * `<`, `>`, `|`, `~`, `\`) become `_` here, so the name saved is the name sent; spaces stay literal, as Claude reads them.
 * An empty name, `.` or `..` names no file.
 */
export function downloadName(name: string): string | null {
  const file = name.replace(/[/?#\\%:"*<>|~]/g, "_");
  return file && file !== "." && file !== ".." ? file : null;
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
  /** `appTools: false`: a view with no View to read (the upload card) declares no `tools` and answers no tool calls. */
  { appTools = true }: { readonly appTools?: boolean } = {},
): () => void {
  // `tools`: the App's own view-only tools, always listed, then the tools of the page shown, if it registers any; the host
  // learns of a change (`listChanged`). A host without app tools never asks for them.
  const app = new App(
    { name: "mantle", version },
    { availableDisplayModes: [...APP_DISPLAY_MODES], ...(appTools ? { tools: { listChanged: true } } : {}) },
    { autoResize: false },
  );
  let closed = false,
    ready = false;
  let shown: (() => ShownView | null) | undefined;
  // each registration of the page shown; `stop` aborts its calls still running when it is removed
  const pages = new Set<{
    readonly tools: readonly AdminAppTool[];
    readonly listed: readonly AppTool[];
    readonly stop: AbortController;
  }>();
  // by name: a component that registers again (new state in its handler) lists and announces nothing new
  const pageTools = () =>
    [...pages].flatMap(page => page.listed).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tools = () => [...APP_TOOLS, ...pageTools()];
  // what the host was last told: an unmount and a registration of the same tools in one task (a re-render) send nothing
  let announced = JSON.stringify(tools()),
    queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const now = JSON.stringify(tools());
      if (closed || now === announced) return;
      announced = now;
      void app.sendToolListChanged().catch(() => {});
    });
  };
  // the official App refuses these handlers without the `tools` capability
  if (appTools) {
    app.onlisttools = async () => ({ tools: tools() });
    app.oncalltool = ({ name, arguments: args }, extra) => {
      // looked up at call time: a tool removed with its page is not called
      const page = closed ? undefined : [...pages].find(page => page.tools.some(tool => tool.name === name));
      return page
        ? callPageTool(
            page.tools.find(tool => tool.name === name)!,
            args ?? {},
            AbortSignal.any([extra.mcpReq.signal, page.stop.signal]),
          )
        : callAppTool(() => (closed ? null : (shown?.() ?? null)), name, args ?? {}, extra.mcpReq.signal);
    };
  }
  let stopResize: (() => void) | undefined;
  let origin: string | undefined, incomingOrigin: string | undefined;
  // The official transport checks the parent WindowProxy. Keep origin continuity as a
  // separate platform guard: only the official successful handshake pins the origin;
  // a parent that subsequently navigates cannot inherit this connection.
  // No message IDs, methods, envelopes or protocol versions are interpreted here.
  // Only a framed App pins. Without a distinct parent (`window.parent === window`: a native
  // WebView, as Claude's mobile apps render Apps) the host's bridge is not a window with an
  // origin to keep, and posting to a pinned origin other than the document's own would drop
  // every later message. Unverified on a real mobile host (#1119): the WebView path keeps
  // the official transport's own source check and its "*" target.
  const framed = win.parent !== win;
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
      if (framed) origin = incomingOrigin;
      ready = true;
      const capabilities = app.getHostCapabilities() ?? {};
      // nothing is sent once closed; a rejection (timeout, lost connection, an error answer) does not say the host did not act
      const ask = async (request: () => Promise<unknown>): Promise<HostRequestOutcome> => {
        if (closed) return "refused";
        try {
          const answer = await request();
          return !record(answer) ? "unknown" : answer.isError === true ? "refused" : "accepted";
        } catch {
          return "unknown";
        }
      };
      handlers.ready(
        {
          capabilities,
          ...(capabilities.serverTools ? { call } : {}),
          openLink: async url =>
            !!capabilities.openLinks && web(url) && (await ask(() => app.openLink({ url }))) === "accepted",
          // every sender comes through here (`useHost().sendMessage`, the upload card): a message the host would
          // refuse is refused without asking it
          sendMessage: async text => {
            const sent = messageText(text);
            return capabilities.message?.text && sent !== null
              ? ask(() => app.sendMessage({ role: "user", content: [{ type: "text", text: sent }] }))
              : "refused";
          },
          updateModelContext: async ({ content, structuredContent }) => {
            const accepts = capabilities.updateModelContext;
            const sent = {
              ...(content && accepts?.text && content.every(block => block.type === "text") ? { content } : {}),
              ...(structuredContent && accepts?.structuredContent ? { structuredContent } : {}),
            };
            return (
              Object.keys(sent).length > 0 &&
              json(sent) &&
              (await ask(() => app.updateModelContext(sent))) === "accepted"
            );
          },
          // the person confirms in the host, so the wait is theirs, not the SDK's default request timeout
          // the URI's last segment names the saved file
          downloadFile: async (name, text, mimeType = "text/plain") => {
            const file = downloadName(name);
            return capabilities.downloadFile && file
              ? ask(() =>
                  app.downloadFile(
                    {
                      contents: [{ type: "resource", resource: { uri: "file:///" + file, mimeType, text } }],
                    },
                    { timeout: 600_000 },
                  ),
                )
              : "refused";
          },
          serveTools: read => {
            shown = read;
          },
          registerTools: list => {
            if (!appTools) throw new Error("This view serves no app tools.");
            const listed = pageToolList(list, pageTools());
            const registration = { tools: [...list], listed, stop: new AbortController() };
            pages.add(registration);
            changed();
            return () => {
              if (!pages.delete(registration)) return;
              registration.stop.abort();
              changed();
            };
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
    for (const page of pages) page.stop.abort();
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

/**
 * The host's presentation fields on the document root. A fixed height (`fullscreen`: the side panel or full screen) bounds
 * the root, which scrolls inside it. In the conversation the host gives only `maxHeight`: it caps the frame and clips what
 * exceeds it, and on a touch screen a vertical pan scrolls the conversation, so the root is not a scroll container there and
 * its content sets the height it reports. `scroll` bounds it by `maxHeight` and scrolls it all the same: the App's fallback
 * when the host offers no full screen or refused it.
 */
export function applyHostContext(
  value: McpUiHostContext,
  doc: Document = document,
  { scroll = false }: { readonly scroll?: boolean } = {},
): void {
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
    const bound =
      box.height !== undefined || scroll ? Math.min(box.height ?? Infinity, box.maxHeight ?? Infinity) : Infinity;
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
