import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

// The actual ext-apps host is the wire oracle, not a mock of our App bridge.
const iframe = document.createElement("iframe");
iframe.title = "Mantle MCP App";
iframe.width = "700"; iframe.height = "800";
document.body.append(iframe);
const calls: unknown[] = [], aborts: string[] = [], sizes: unknown[] = [], errors: string[] = [];
const bridge = new AppBridge(null, { name: "mantle-app-host-test", version: "1" }, { serverTools: {} }, {
  hostContext: { locale: location.search.includes("bad-handshake") ? 1 as unknown as string : "zh-TW", theme: "dark", toolInfo: { tool: { name: "pending", inputSchema: { type: "object" } } }, styles: { variables: { "--color-text-primary": "rgb(1, 2, 3)" } } },
});
let ready = false;
bridge.oninitialized = () => { ready = true; };
bridge.onsizechange = value => { sizes.push(value); };
bridge.onerror = error => { errors.push(error.message); };
bridge.oncalltool = async (params, extra) => {
  calls.push(params);
  if (params.name === "wait") {
    await extra.mcpReq.notify({ method: "notifications/progress", params: { progressToken: params._meta!.progressToken!, progress: 1 } });
    return new Promise((_, reject) => extra.mcpReq.signal.addEventListener("abort", () => { aborts.push(params.name); reject(new Error("Cancelled")); }, { once: true }));
  }
  if (params.name === "review_requisition") return { content: [], structuredContent: { id: "r1" } };
  return { content: [], structuredContent: { rows: [{ id: "r1", version: 3, item: "Laptops", date: "2026-10-01T15:20:00.000Z" }] }, _meta: { "net.aotter.mantle/tool": "pending" } };
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
Object.assign(window, { host: { bridge, calls, aborts, sizes, errors, get ready() { return ready; } } });
iframe.src = location.search ? "/test/mcp-app-probe.html" : "/src/mcp-app/interaction.html";
