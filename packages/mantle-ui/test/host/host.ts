/**
 * A minimal MCP Apps host on the official SDKs, in the shape of the ext-apps
 * `examples/basic-host`: an MCP client with the UI extension, the App's
 * `ui://` resource in a sandboxed iframe, and an `AppBridge` that forwards
 * the App's tool calls to the server. Used by CI only (#1119).
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const status = document.getElementById("status")!;
const log = (text: string) => { status.textContent = text; };
const params = new URLSearchParams(location.search);
const toolName = params.get("tool")!;

const client = new Client(
  { name: "mantle-basic-host", version: "1.0.0" },
  { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
);
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.origin)));
const { tools } = await client.listTools();
const tool = tools.find(({ name }) => name === toolName);
const uri = (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
if (!tool || !uri) throw new Error(`Tool ${toolName} links no UI resource`);
const resource = await client.readResource({ uri });
const html = (resource.contents[0] as { text: string }).text;

const iframe = document.getElementById("app") as HTMLIFrameElement;
const bridge = new AppBridge(client, { name: "mantle-basic-host", version: "1.0.0" }, { serverTools: {}, logging: {} });
bridge.oninitialized = async () => {
  const args = {};
  await bridge.sendToolInput({ arguments: args });
  const result = await client.callTool({ name: toolName, arguments: args });
  await bridge.sendToolResult(result);
  log("result delivered");
};
iframe.srcdoc = html;
await new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
log("bridge connected");
