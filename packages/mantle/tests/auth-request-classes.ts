/** Authority counts only: dispatch stubs perform no content queries. Shared with native PG and local D1. */
import assert from "node:assert/strict";
import { resolveCaller, type AuthLoader } from "../src/auth/caller.js";
import { rest } from "../src/kernel/rest.js";
import { mcp, type Tool } from "../src/kernel/mcp.js";
import { web } from "../src/kernel/web.js";

export async function verifyAuthRequestClasses(loader: AuthLoader | (() => AuthLoader), cookie: string, statements: string[], expectedRead: number, expectedWrite: number) {
  const caller = (request: Request, _env: unknown, authority: { readOnly: boolean }) => resolveCaller(request, typeof loader === "function" ? loader() : loader, authority);
  const page = async () => ({ rows: [{ id: "one", body: "hello" }] });
  const tools: Tool<null>[] = [
    { name: "delete_named_view", surface: "public", description: "View", inputSchema: { type: "object" }, validate: () => ({}), path: "view", page },
    { name: "read_named_procedure", surface: "public", description: "Procedure", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, validate: () => ({}), run: async () => ({ ok: true }) },
    { name: "native_read", surface: "staff", description: "Native read", inputSchema: { type: "object" }, validate: () => ({}), run: async () => ({ ok: true }) },
    { name: "publish", surface: "staff", description: "Publishing", inputSchema: { type: "object" }, validate: () => ({}), run: async () => ({ ok: true }) },
  ];
  const options = { db: () => null, caller };
  const api = rest([
    { method: "GET", pattern: /^\/view$/, query: () => ({ input: {} }), page },
    { method: "POST", pattern: /^\/write$/, validate: () => ({}), run: async () => ({ ok: true }) },
    { method: "GET", pattern: /^\/sensitive$/, validate: () => ({}), run: async () => ({ ok: true }) },
  ], options);
  const serve = mcp(tools, ["user", "staff"], options, [{ name: "delete_named_view", surface: "public" }, { name: "native_read", surface: "staff" }]);
  const site = web({ db: null, caller, origin: "http://localhost:3000", title: "Fixture", description: "", pages: { "/one": { view: "view", markdown: "body" } } }, [["view", { query: () => ({ input: {} }), page }]]);
  const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3000${path}`, { method, headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json", accept: "application/json, text/event-stream" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const message = (method: string, name?: string) => ({ jsonrpc: "2.0", id: 1, method, params: name ? { name, arguments: {} } : method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } : {} });
  const cases: [string, boolean, () => Promise<unknown>][] = [
    ["REST read", true, () => api(request("/view"), {})],
    ["REST HEAD View", true, () => api(request("/view", "HEAD"), {})],
    ["REST write", false, () => api(request("/write", "POST", {}), {})],
    ["REST GET Procedure", false, () => api(request("/sensitive", "GET"), {})],
    ["MCP read tool", true, () => serve(request("/mcp", "POST", message("tools/call", "delete_named_view")), {})],
    ["MCP write tool", false, () => serve(request("/mcp", "POST", message("tools/call", "read_named_procedure")), {})],
    ...["initialize", "tools/list", "resources/list", "resources/read"].map(method => [`MCP ${method}`, true, () => serve(request("/mcp", "POST", message(method)), {})] as [string, boolean, () => Promise<unknown>]),
    ["Admin MCP read", true, () => serve(request("/mcp/staff", "POST", message("tools/call", "native_read")), {})],
    ["publishing", false, () => serve(request("/mcp/staff", "POST", message("tools/call", "publish")), {})],
    ["MCP mixed batch", false, () => serve(request("/mcp", "POST", [message("tools/call", "delete_named_view"), { ...message("tools/call", "read_named_procedure"), id: 2 }]), {})],
    ["MCP unknown tool", false, () => serve(request("/mcp", "POST", message("tools/call", "missing")), {})],
    ["MCP unknown method", false, () => serve(request("/mcp", "POST", message("unknown")), {})],
    ["MCP malformed message", false, () => serve(request("/mcp", "POST", { ...message("tools/list"), jsonrpc: "invalid" }), {})],
    ["MCP oversized message", false, () => serve(request("/mcp", "POST", { ...message("tools/list"), extra: "x".repeat(1024 * 1024) }), {})],
    ["web page", true, () => site.fetch(request("/one.md"), {})],
    ["web HEAD", true, () => site.fetch(request("/one.md", "HEAD"), {})],
  ];
  for (const [name, read, run] of cases) {
    statements.length = 0;
    const response = await run();
    // Unknown MCP calls may be protocol errors; authority must still fail safely to the primary path.
    assert.ok(response instanceof Response, name);
    if (!["MCP resources/read", "MCP mixed batch", "MCP unknown tool", "MCP unknown method", "MCP malformed message", "MCP oversized message"].includes(name)) assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
    if (name === "MCP oversized message") assert.equal(response.status, 413);
    const text = await response.text();
    if (name.includes("HEAD")) assert.equal(text, "", `${name}: no response body`);
    assert.equal(statements.filter(text => /^\s*(SELECT|WITH)\b/i.test(text)).length, read ? expectedRead : expectedWrite, `${name}: ${statements.join("\n")}`);
    assert.equal(statements.some(text => text.includes('"oauthResource"')), false, `${name}: no OAuth resource work`);
    assert.equal(statements.some(text => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)), false, `${name}: authority writes`);
  }
}
