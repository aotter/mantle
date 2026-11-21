/** Core serves MCP protocol revision 2026-07-28 only: a 2025-era client is refused clearly, observed and not logged. */
import { expect, spyOn, test } from "bun:test";
import { mcp, type McpObservation } from "../src/kernel/mcp.js";
import { mcpClient } from "./mcp-client.js";
import { legacyInitialize, mcpHeaders, mcpInit, mcpMessage, MCP_REVISION } from "./mcp-wire.js";

const tools = [
  {
    name: "echo",
    surface: "public",
    description: "echo",
    inputSchema: { type: "object" },
    validate: (raw: any) => raw,
    run: async () => ({ ok: true }),
  },
];

test("a 2025-era initialize, an envelope-less call and a batch are refused; a notification is accepted; GET and DELETE are 405", async () => {
  const events: McpObservation[] = [];
  const handle = mcp(tools as never, {
    db: () => ({}),
    caller: () => ({ kind: "anonymous" }),
    onObservation: event => void events.push(event),
  });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      handle(
        new Request("https://app.test/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
          body: JSON.stringify(body),
        }),
        {},
      );
    const refusal = { code: -32022, data: { supported: [MCP_REVISION] } };
    // A 2025-era handshake.
    const initialize = (await post(legacyInitialize, { "mcp-protocol-version": "2025-11-25" }))!;
    expect(initialize.status).toBe(400);
    const answer = (await initialize.json()) as any;
    expect(answer).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32022 } });
    expect(answer.error.data.supported).toEqual([MCP_REVISION]);
    expect(answer.error.data.requested).toBe("2025-11-25");
    // A call without the `_meta` envelope names no revision.
    const bare = (await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    }))!;
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ id: 2, error: refusal });
    // 2026-07-28 has no batches.
    const batch = (await post([mcpMessage("tools/list")]))!;
    expect(batch.status).toBe(400);
    // A notification needs no answer.
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }))!.status).toBe(202);
    for (const method of ["GET", "DELETE"]) {
      const refused = (await handle(new Request("https://app.test/mcp", { method }), {}))!;
      expect([method, refused.status, refused.headers.get("allow")]).toEqual([method, 405, "POST"]);
    }
    // Other refusals the client causes: headers that contradict the body, an invalid envelope, a body that is not JSON.
    const listing = mcpMessage("tools/list");
    expect((await post(listing, { ...mcpHeaders(listing), "mcp-method": "tools/call" }))!.status).toBe(400);
    const envelope = mcpMessage("tools/list", { _meta: { "io.modelcontextprotocol/clientInfo": "nobody" } });
    expect((await post(envelope, mcpHeaders(envelope)))!.status).toBe(400);
    expect((await post(listing, { ...mcpHeaders(listing), "content-type": "text/plain" }))!.status).toBe(415);
    // Each protocol-version refusal is observed, with its own reason; no refusal the client caused is logged as a
    // failure of the server.
    expect(events).toEqual([
      expect.objectContaining({ kind: "request-refused", surface: "public", status: 400, reason: "protocol-version" }),
      expect.objectContaining({ kind: "request-refused", surface: "public", status: 400, reason: "protocol-version" }),
    ]);
    expect(errors.mock.calls.filter(([text]) => String(text).includes("[mantle mcp]"))).toEqual([]);
    // A fault of the server is: two tools of one name fail to register.
    const faulty = mcp([...tools, ...tools] as never, { db: () => ({}), caller: () => ({ kind: "anonymous" }) });
    const fault = (await faulty(new Request("https://app.test/mcp", mcpInit(listing)), {}))!;
    expect(fault.status).toBe(500);
    expect(
      errors.mock.calls.filter(([text]) => String(text).includes("[mantle mcp]")).map(([, error]) => String(error)),
    ).toEqual([expect.stringContaining("echo")]);
  } finally {
    errors.mockRestore();
  }
});

test("a 2026-07-28 client discovers the server, lists and calls; the observation names its client", async () => {
  const events: McpObservation[] = [];
  const handle = mcp(tools as never, {
    db: () => ({}),
    caller: () => ({ kind: "anonymous" }),
    onObservation: event => void events.push(event),
  });
  const discovered = (await handle(new Request("https://app.test/mcp", mcpInit(mcpMessage("server/discover"))), {}))!;
  expect(discovered.status).toBe(200);
  const client = await mcpClient(handle, undefined, { name: "observed-client", version: "4.2" });
  expect(client.getNegotiatedProtocolVersion()).toBe(MCP_REVISION);
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["echo"]);
  expect((await client.callTool({ name: "echo", arguments: {} })).structuredContent).toEqual({ ok: true });
  await client.close();
  expect(
    events.filter(e => e.kind === "invocation").map(e => [e.kind === "invocation" && e.phase, (e as any).client]),
  ).toEqual([
    ["attempt", { name: "observed-client", version: "4.2" }],
    ["completion", { name: "observed-client", version: "4.2" }],
  ]);
});

test("a 2025-era initialize with cookie authority reaches the -32022 answer, resolved with fresh authority", async () => {
  const { user } = await import("./apps/fixtures.js");
  const hints: boolean[] = [];
  const closed = tools.map(tool => ({ ...tool, closed: true }));
  const handle = mcp(closed as never, {
    db: () => ({}),
    caller: (request, _env, { readOnly }) => {
      hints.push(readOnly);
      return request.headers.get("cookie") === "session=valid" ? user("person") : { kind: "anonymous" };
    },
  });
  const post = (cookie: string) =>
    handle(
      new Request("https://app.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", cookie },
        body: JSON.stringify(legacyInitialize),
      }),
      {},
    );
  const refused = (await post("session=valid"))!;
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as any).error.code).toBe(-32022);
  // Without a session the closed surface challenges first, as it does any anonymous request.
  expect((await post("session=expired"))!.status).toBe(401);
  // `initialize` is not a catalogue read, so the resolver is not offered cached authority.
  expect(hints).toEqual([false, false]);
});
