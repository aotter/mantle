import { afterEach, expect, spyOn, test } from "bun:test";
import { mcp } from "../src/kernel/mcp.js";
import { checkOrigin } from "../src/kernel/contracts.js";
import { fixtureCaller } from "./apps/fixtures.js";

const kit = await import(new URL("../../../docs/examples/app-shell/smoke-kit.mjs", import.meta.url).href);
const endpoint = "http://127.0.0.1:8787/mcp/admin";
const tools = ["read_inventory", "place_order"].map(name => ({ name, inputSchema: { type: "object" as const } }));
let requests: any[] = [];
let transport: ReturnType<typeof spyOn>;
afterEach(() => {
  transport?.mockRestore();
  requests = [];
});
const result = (id: number, value: object) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: value }), {
    headers: { "content-type": "application/json" },
  });
const discovered = {
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: {} },
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "test", version: "1" } },
};
function respond(reply: (body: any, init: any) => Response) {
  transport = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return reply(body, init);
  }) as typeof fetch);
}

test("discovery sends 2026-07-28 requests, forwards the supplied identity, and reads every tools/list page without writes", async () => {
  respond((body, init) => {
    const headers = new Headers(init.headers);
    expect(init.redirect).toBe("error");
    expect(headers.get("authorization")).toBe("Bearer supplied-test-credential");
    // Every request carries the 2026-07-28 envelope and the headers that state it.
    expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(headers.get("mcp-method")).toBe(body.method);
    expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(body.params._meta["io.modelcontextprotocol/clientCapabilities"]).toBeObject();
    if (body.method === "server/discover") return result(body.id, discovered);
    expect(body.method).toBe("tools/list");
    return result(body.id, body.params.cursor ? { tools: [tools[1]] } : { tools: [tools[0]], nextCursor: "second" });
  });
  expect(
    await kit.assertMcpDiscovery(endpoint, { headers: { authorization: "Bearer supplied-test-credential" }, tools }),
  ).toEqual(tools.map(t => t.name).sort());
  expect(requests.map(r => r.method)).toEqual(["server/discover", "tools/list", "tools/list"]);
});

test("discovery supports an explicit permitted subset and SSE replies", async () => {
  respond(
    body =>
      new Response(
        `: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "server/discover" ? discovered : { tools: [tools[0]] } })}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  expect(await kit.assertMcpDiscovery(endpoint, { tools: tools.slice(0, 1) })).toEqual(["read_inventory"]);
});

for (const [name, status] of [
  ["forgotten route", 404],
  ["anonymous refusal", 401],
  ["member refusal", 403],
] as const) {
  test(`${name} is not successful discovery`, async () => {
    respond(() => new Response("denied", { status }));
    await expect(kit.assertMcpDiscovery(endpoint, { tools })).rejects.toThrow(`HTTP ${status}`);
  });
}
for (const [name, reply] of [
  ["HTML 200", () => new Response("<html>sign in</html>")],
  [
    "MCP error",
    (body: any) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "failed" } }), {
        headers: { "content-type": "application/json" },
      }),
  ],
  ["wrong id", (body: any) => result(body.id + 1, discovered)],
  ["invalid protocol", (body: any) => result(body.id, {})],
  ["no 2026-07-28 support", (body: any) => result(body.id, { ...discovered, supportedVersions: ["2025-11-25"] })],
  ["invalid tools capability", (body: any) => result(body.id, { ...discovered, capabilities: { tools: [] } })],
] as const) {
  test(`${name} fails even with HTTP 200`, async () => {
    respond(reply);
    await expect(kit.assertMcpDiscovery(endpoint, { tools })).rejects.toThrow();
  });
}
for (const [name, listed] of [
  ["missing expected tool", { tools: [tools[0]] }],
  ["unexpected tool", { tools: [...tools, { name: "private_tool", inputSchema: { type: "object" } }] }],
  ["missing tool schema", { tools: [{ name: "read_inventory" }, tools[1]] }],
  ["invalid tool schema", { tools: [{ name: "read_inventory", inputSchema: [] }, tools[1]] }],
  ["non-object tool schema", { tools: [{ name: "read_inventory", inputSchema: { type: "string" } }, tools[1]] }],
  ["malformed tools", { tools: [null] }],
  ["duplicate tool", { tools: [tools[0], tools[0]] }],
  ["invalid cursor", { tools, nextCursor: 4 }],
  ["cursor cycle", { tools: [], nextCursor: "again" }],
] as const) {
  test(`${name} fails discovery acceptance`, async () => {
    respond(body => (body.method === "server/discover" ? result(body.id, discovered) : result(body.id, listed)));
    await expect(kit.assertMcpDiscovery(endpoint, { tools })).rejects.toThrow();
  });
}

test("a server generating endlessly new cursors is bounded", async () => {
  let pages = 0;
  respond(body =>
    body.method === "server/discover"
      ? result(body.id, discovered)
      : result(body.id, { tools: [], nextCursor: String(++pages) }),
  );
  await expect(kit.assertMcpDiscovery(endpoint, { tools })).rejects.toThrow("exceeded 100 pages");
  expect(pages).toBe(100);
});

test("the shipped assertion accepts the real Mantle MCP handler without executing a tool", async () => {
  const caller = fixtureCaller({
    kind: "user",
    subject: "test-admin",
    role: "admin",
    admin: true,
    credential: "session",
    scopes: [],
    credentialId: null,
    clientId: null,
  });
  const declarations = tools.map(tool => ({
    ...tool,
    description: tool.name,
    surface: "admin" as const,
    inputSchema: { type: "object" as const },
    validate: () => ({}),
    run: async () => {
      throw new Error("discovery must not execute business tools");
    },
  }));
  const handle = mcp(declarations, {
    db: () => ({}),
    caller: request => {
      checkOrigin(request, caller);
      return caller;
    },
  });
  transport = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: any) => {
    const response = await handle(new Request(url, init), {});
    expect(response).toBeInstanceOf(Response);
    return response!;
  }) as typeof fetch);
  expect(
    await kit.assertMcpDiscovery(endpoint, {
      tools,
      headers: { cookie: "supplied-session", origin: new URL(endpoint).origin },
    }),
  ).toEqual(tools.map(tool => tool.name).sort());
});
