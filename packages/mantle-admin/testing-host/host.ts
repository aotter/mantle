// The MCP host page `@aotter/mantle-admin/testing` loads: the official ext-apps AppBridge around the App's iframe. The test
// (`src/testing/index.ts`) sets `window.__mantleScenario` before this runs and reads `window.host` after.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

interface Scenario {
  readonly tool: string;
  readonly theme: "light" | "dark";
  /** Sample rows by tool: what the host answers when the App (or a page's `useView`) calls a View's tool. */
  readonly rows: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}
const scenario = (window as unknown as { __mantleScenario: Scenario }).__mantleScenario;

const result = (tool: string) => {
  const rows = scenario.rows[tool] ?? [];
  return { content: [{ type: "text" as const, text: JSON.stringify({ rows }) }], structuredContent: { rows }, _meta: { "net.aotter.mantle/tool": tool } };
};

const iframe = document.createElement("iframe");
iframe.title = "Mantle MCP App";
iframe.width = "700"; iframe.height = "800";
// the sandbox a host gives an App; the document comes from another origin with the spec's default CSP (the test serves both)
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
document.body.append(iframe);

const errors: string[] = [], state = { done: false, height: 0 };
const bridge = new AppBridge(null, { name: "mantle-compatibility-host", version: "1" }, { serverTools: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } }, {
  hostContext: {
    locale: "en", theme: scenario.theme, timeZone: "UTC",
    availableDisplayModes: ["inline", "fullscreen"], displayMode: "inline",
    toolInfo: { tool: { name: scenario.tool, inputSchema: { type: "object" } } },
  },
});
bridge.oninitialized = () => {
  void (async () => {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(result(scenario.tool));
    state.done = true;
  })().catch(error => errors.push(String(error)));
};
bridge.onsizechange = value => { state.height = Math.max(state.height, Number(value.height ?? 0)); };
bridge.onerror = error => { errors.push(error.message); };
bridge.onopenlink = async () => ({});
bridge.onmessage = async () => ({});
bridge.onupdatemodelcontext = async () => ({});
bridge.onrequestdisplaymode = async ({ mode }) => ({ mode });
bridge.oncalltool = async params => result(params.name);
Object.assign(window, { host: { errors, state } });
void bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)).then(() => { iframe.src = "https://app.test/app.html"; }, error => errors.push(String(error)));
