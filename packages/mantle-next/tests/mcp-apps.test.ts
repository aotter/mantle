import { expect, test } from "bun:test";
import { mcp, type Tool } from "../src/kernel/mcp.js";
import { clientUiSupport, linkApps, planApp, RESOURCE_MIME_TYPE } from "../src/kernel/mcp-apps.js";
import { generateOrThrow, loadFixtureSources, writeGenerated } from "./apps/link.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };
const meta = { "io.modelcontextprotocol/clientCapabilities": capabilities };
const tools: Tool<null>[] = ["rows", "lookup"].map(name => ({ name, surface: "public", description: name, inputSchema: { type: "object", additionalProperties: false }, validate: () => ({}), page: async () => ({ rows: [{ id: "a" }] }) }));

test("Apps capability, registration, metadata and hidden View validation retain 0.2 behavior", async () => {
  expect(clientUiSupport({ method: "initialize", params: { capabilities: {} } })).toBe("unsupported");
  expect(clientUiSupport({ method: "initialize", params: { capabilities } })).toBe("supported");
  expect(clientUiSupport([{ method: "tools/list", params: { _meta: meta } }])).toBe("supported");
  expect(clientUiSupport({ method: "tools/list" })).toBe("unknown");
  const resource = { uri: "ui://mantle/public", name: "public", html: async () => "<html>App</html>", renders: ["rows"], appOnly: ["lookup"], csp: { connectDomains: ["https://app.test"] }, permissions: { clipboardWrite: {} }, prefersBorder: false };
  expect(() => linkApps({ resources: [resource, resource] }, new Set(["rows", "lookup"]), new Set(["rows", "lookup"]))).toThrow("twice");
  expect(() => linkApps({ resources: [{ ...resource, appOnly: ["write"] }] }, new Set(["rows", "lookup", "write"]), new Set(["rows", "lookup"]))).toThrow("must be a View");
  let calls = 0;
  const counted = tools.map(tool => ({ ...tool, page: async (...args: Parameters<NonNullable<typeof tool.page>>) => { calls++; return tool.page!(...args); } }));
  const handle = mcp(counted, ["staff"], { db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: { resources: [resource] }, staff: { resources: [{ uri: "ui://mantle/staff", name: "staff", html: "private" }] } } });
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handle(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), {});
    const text = await response!.text();
    return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text);
  };
  const unsupported = await call("tools/list", { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } });
  expect(unsupported.result.tools.map((t: any) => t.name)).toEqual(["rows"]);
  expect(unsupported.result.tools[0]._meta).toBeUndefined();
  expect((await call("resources/list", { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } })).result).toBeUndefined();
  expect((await call("tools/call", { name: "lookup", arguments: {}, _meta: { "io.modelcontextprotocol/clientCapabilities": {} } })).error).toBeDefined();
  const supported = (await call("tools/list", { _meta: meta })).result.tools;
  expect(supported[0]._meta).toEqual({ ui: { resourceUri: resource.uri }, "ui/resourceUri": resource.uri, "openai/outputTemplate": resource.uri });
  expect(supported[1]._meta.ui.visibility).toEqual(["app"]);
  expect(supported[1]._meta["openai/outputTemplate"]).toBeUndefined();
  expect((await call("tools/list")).result.tools).toHaveLength(2);
  const read = (await call("resources/read", { uri: resource.uri, _meta: meta })).result.contents[0];
  expect(read.text).toBe("<html>App</html>");
  expect(read.mimeType).toBe(RESOURCE_MIME_TYPE);
  expect(read._meta.ui).toEqual({ csp: resource.csp, permissions: resource.permissions, prefersBorder: false });
  expect((await call("resources/read", { uri: "ui://mantle/staff", _meta: meta })).error).toBeDefined();
  expect(calls).toBe(0);
  expect((await call("tools/call", { name: "rows", arguments: {}, _meta: meta })).result._meta).toEqual({ "net.aotter.mantle/tool": "rows" });
  expect(calls).toBe(1);
});

test("Generated App embeds the existing catalogue without a runtime plan or UI startup dependency", async () => {
  const files = await generateOrThrow("cloudflare-d1", await loadFixtureSources());
  const dir = await mkdtemp(resolve(import.meta.dir, ".mcp-apps-"));
  try {
    await writeGenerated(dir, files);
    const { planApp: generatedApp } = await import(resolve(dir, "mcp-app.ts"));
    const { mcpAppCatalogues } = await import(resolve(dir, "admin-descriptors.ts"));
    const resource = generatedApp({ surface: "staff", html: "<html><head></head></html>" });
    expect(resource.renders).toEqual(Object.keys(mcpAppCatalogues.staff.views));
    expect(resource.html).toContain('id="mantle-catalog"');
    expect(JSON.parse(resource.html.split('id="mantle-catalog">')[1].split("</script>")[0])).toEqual(mcpAppCatalogues.staff);
    const escaped = planApp({ views: { "</script>$&": {} }, actions: {} }, { surface: "public", html: "</head>" });
    expect(escaped.html).toContain("\\u003c/script>$&");
    let htmlReads = 0;
    const lazy = generatedApp({ surface: "staff", html: async () => { htmlReads++; return "</head>"; } });
    expect(htmlReads).toBe(0);
    expect(await lazy.html()).toContain('id="mantle-catalog"');
    expect(htmlReads).toBe(1);
    const { build } = await import("esbuild");
    const entry = resolve(dir, "worker.ts");
    const viewEntry = Object.keys(files).find(name => name.startsWith("views/") && name.endsWith(".ts"))!;
    await writeFile(entry, `export { default } from ${JSON.stringify("./" + viewEntry)};`);
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: "esm", platform: "neutral" });
    expect(Object.keys(bundle.metafile!.inputs).some(name => /kernel\/mcp-apps|mantle-ui|modelcontextprotocol/.test(name))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("App setup refuses ambiguous bindings and hides errors behind the same tool result metadata", async () => {
  const r = { uri: "ui://a", name: "a", html: "a", renders: ["rows"] };
  const names = new Set(["rows", "lookup"]);
  expect(() => linkApps({ resources: [{ ...r, uri: "https://a" }] }, names, names)).toThrow("ui://");
  expect(() => linkApps({ resources: [{ ...r, renders: ["missing"] }] }, names, names)).toThrow("does not serve");
  expect(() => linkApps({ resources: [r, { ...r, uri: "ui://b", renders: [], appOnly: ["rows"] }] }, names, names)).toThrow("both");
  const handle = mcp([{ ...tools[0]!, page: async () => { throw new Error("internal secret"); } }], ["staff"], { db: () => null, caller: () => ({ kind: "anonymous" }), apps: { public: { resources: [r] } } });
  const { spyOn } = await import("bun:test");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await handle(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rows", arguments: {}, _meta: meta } }) }), {});
    const text = await response!.text();
    expect(text).toContain('"net.aotter.mantle/tool":"rows"');
    expect(text).toContain('"isError":true');
    expect(text).not.toContain("internal secret");
  } finally { logged.mockRestore(); }
});


test("Resource loader failures never expose callback errors, credentials or metadata", async () => {
  let dbCalls = 0, htmlCalls = 0;
  const privateValue = "FAKE_PRIVATE_HTML_ERROR FAKE_TOKEN";
  const handle = mcp([], ["staff"], { db: () => { dbCalls++; return null; }, caller: () => ({ kind: "anonymous" }), apps: { public: { resources: [{ uri: "ui://a", name: "app", html: async () => { htmlCalls++; throw new Error(privateValue); } }] }, staff: { resources: [{ uri: "ui://staff", name: "staff", html: async () => { htmlCalls++; return privateValue; } }] } } });
  const { spyOn } = await import("bun:test");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const request = (path: string, uri: string) => new Request("https://app.test" + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer FAKE_TOKEN" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri, _meta: { ...meta, privateValue } } }) });
    const response = await handle(request("/mcp", "ui://a"), {});
    const text = await response!.text();
    expect(text).toContain('"code":-32603');
    expect(text).toContain('"message":"Internal error."');
    expect(text).not.toContain(privateValue);
    expect(text).not.toContain("FAKE_TOKEN");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(privateValue);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("FAKE_TOKEN");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(htmlCalls).toBe(1);
    expect((await handle(request("/mcp/staff", "ui://staff"), {}))!.status).toBe(401);
    expect(htmlCalls).toBe(1);
    expect(dbCalls).toBe(0);
  } finally { logged.mockRestore(); }
});
