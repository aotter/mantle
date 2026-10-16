import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

// The actual ext-apps host is the wire oracle, not a mock of our App bridge.
const iframe = document.createElement("iframe");
iframe.title = "Mantle MCP App";
iframe.width = "700"; iframe.height = "800";
document.body.append(iframe);
const calls: unknown[] = [], aborts: string[] = [], sizes: unknown[] = [], errors: string[] = [], links: string[] = [], messages: unknown[] = [], contexts: unknown[] = [], modes: string[] = [];
// `?read-only`: a host that renders Apps but offers no server tools
const readOnly = location.search.includes("read-only");
const bridge = new AppBridge(null, { name: "mantle-app-host-test", version: "1" }, readOnly ? {} : { serverTools: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } }, {
  hostContext: {
    locale: location.search.includes("bad-handshake") ? 1 as unknown as string : "zh-TW", theme: "dark", timeZone: "Asia/Taipei",
    availableDisplayModes: ["inline", "fullscreen"], displayMode: "inline", safeAreaInsets: { top: 0, right: 0, bottom: 24, left: 0 },
    toolInfo: { tool: { name: "pending", inputSchema: { type: "object" } } },
    styles: { variables: { "--color-text-primary": "rgb(1, 2, 3)", "--color-background-inverse": "rgb(7, 8, 9)", "--color-ring-primary": "rgb(4, 5, 6)", "--border-radius-md": "3px", "--font-weight-medium": "550" } as never },
  },
});
let ready = false;
bridge.oninitialized = () => { ready = true; };
bridge.onsizechange = value => { sizes.push(value); };
bridge.onerror = error => { errors.push(error.message); };
bridge.onopenlink = async ({ url }) => { links.push(url); return {}; };
bridge.onmessage = async params => { messages.push(params); return {}; };
bridge.onupdatemodelcontext = async params => { contexts.push(params); return {}; };
bridge.onrequestdisplaymode = async ({ mode }) => { modes.push(mode); return { mode }; };
bridge.oncalltool = async (params, extra) => {
  calls.push(params);
  if (params.name === "wait") {
    await extra.mcpReq.notify({ method: "notifications/progress", params: { progressToken: params._meta!.progressToken!, progress: 1 } });
    return new Promise((_, reject) => extra.mcpReq.signal.addEventListener("abort", () => { aborts.push(params.name); reject(new Error("Cancelled")); }, { once: true }));
  }
  if (params.name === "pending" && params.arguments?.cursor === "c2") return { content: [], structuredContent: { rows: [{ id: "r2", version: 1, item: "Desks" }] }, _meta: { "net.aotter.mantle/tool": "pending" } };
  if (params.name === "review_requisition") return { content: [], structuredContent: { id: "r1" } };
  return { content: [], structuredContent: { rows: [{ id: "r1", version: 3, item: "Laptops", date: "2026-10-01T15:20:00.000Z", link: "https://example.com/r1" }] }, _meta: { "net.aotter.mantle/tool": "pending" } };
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
Object.assign(window, { host: { bridge, calls, aborts, sizes, errors, links, messages, contexts, modes, get ready() { return ready; } } });
iframe.src = location.search && !readOnly ? "/test/mcp-app-probe.html" : "/mcp-app.html";
