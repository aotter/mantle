import { test, expect } from "bun:test";
import { mcp, type Tool } from "../src/kernel/mcp.js";

// A separate process keeps an earlier test's SDK import from hiding a startup regression.
test("staff probes resolve authority before loading the SDK or reading a body", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    let loaded = false;
    mock.module("@modelcontextprotocol/server", () => { loaded = true; throw Error("SDK loaded before challenge"); });
    const { mcp } = await import(${JSON.stringify(new URL("../src/kernel/mcp.ts", import.meta.url).pathname)});
    const handle = mcp(() => { throw Error("staff table loaded before challenge"); }, [], {
      db: () => null, caller: (request, env, authority) => { assert.equal(authority.readOnly, false); return { kind: "anonymous" }; }
    });
    for (const headers of [{}, { authorization: "Bearer invalid" }, { cookie: "session=x", authorization: "Bearer invalid" }]) {
      const request = new Request("https://app.test/mcp/staff", { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) });
      request.clone = () => { throw Error("body read before challenge"); };
      const response = await handle(request, {});
      assert.equal(response.status, 401);
      assert.ok(response.headers.get("www-authenticate").includes("resource_metadata="));
      assert.equal(request.bodyUsed, false);
      assert.equal(loaded, false);
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});

test("app-composed tools need an explicit read catalogue for cached cookie authority", async () => {
  const tools: Tool<null>[] = [
    { name: "view", surface: "public", description: "View", inputSchema: { type: "object" }, validate: () => ({}), page: async () => ({ rows: [] }) },
    { name: "write", surface: "public", description: "Write", inputSchema: { type: "object" }, validate: () => ({}), ...{ readOnly: true }, annotations: { readOnlyHint: true }, run: async () => ({}) },
  ];
  let readOnly: boolean | undefined;
  const options = { db: () => null, caller: (_request: Request, _env: unknown, authority: { readOnly: boolean }) => { readOnly = authority.readOnly; return { kind: "anonymous" } as const; } };
  for (const [reads, name, headers, expected] of [
    [[], "view", { cookie: "fixture=x" }, false],
    [[], "write", { cookie: "fixture=x" }, false],
    [[{ name: "view", surface: "public" }], "view", { cookie: "fixture=x" }, true],
    [[{ name: "view", surface: "public" }], "view", { authorization: "Bearer fixture" }, false],
    [[{ name: "view", surface: "public" }], "view", {}, false],
  ] as const) {
    const handle = mcp(tools, [], options, reads);
    const response = await handle(new Request("https://app.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) }), {});
    expect(response?.status).toBe(200);
    await response?.text();
    expect(readOnly).toBe(expected);
  }
});
