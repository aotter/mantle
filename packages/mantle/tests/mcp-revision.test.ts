/**
 * Core serves both MCP protocol eras: the 2025 revisions statelessly and 2026-07-28. What each era gets, what is still
 * refused (a revision neither era serves, a batch with a 2026-07-28 element, contradicting headers), how the SDK routes
 * each request and what a host may forward in either form.
 */
import { expect, spyOn, test } from "bun:test";
import { classifyInboundRequest } from "@modelcontextprotocol/server";
import { mcp, type McpObservation, type Tool } from "../src/kernel/mcp.js";
import { mantleProps } from "./gateway-fixture.js";
import { mcpClient } from "./mcp-client.js";
import {
  ERAS,
  LEGACY_REVISION,
  legacyInit,
  legacyInitialize,
  mcpHeaders,
  mcpInit,
  mcpMessage,
  MCP_REVISION,
} from "./mcp-wire.js";

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
const json = async (response: Response) => {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text);
};
const call = (name: string, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

test("a 2025-era client is served statelessly: initialize, initialized, list, call and a batch; GET and DELETE are 405", async () => {
  const events: McpObservation[] = [];
  const handle = mcp(tools as never, {
    db: () => ({}),
    caller: () => ({ kind: "anonymous" }),
    onObservation: event => void events.push(event),
  });
  const post = (body: unknown, init?: RequestInit) =>
    handle(new Request("https://app.test/mcp", legacyInit(body, init)), {});
  const initialized = (await post(legacyInitialize, { headers: { "mcp-protocol-version": "" } }))!;
  expect(initialized.status).toBe(200);
  expect((await json(initialized)).result).toMatchObject({
    protocolVersion: LEGACY_REVISION,
    serverInfo: { name: "aotter.mantle" },
  });
  expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }))!.status).toBe(202);
  expect((await json((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }))!)).result.tools).toHaveLength(1);
  expect((await json((await post(call("echo")))!)).result.structuredContent).toEqual({ ok: true });
  // 2025-03-26 and earlier allow batches: each call runs and answers in order.
  const batch = (await post([call("echo", "a"), call("echo", "b")]))!;
  expect(batch.status).toBe(200);
  const answers = (await batch.text())
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .flatMap(line => JSON.parse(line.slice(6)));
  expect(answers.map((answer: any) => [answer.id, answer.result.structuredContent])).toEqual([
    ["a", { ok: true }],
    ["b", { ok: true }],
  ]);
  for (const method of ["GET", "DELETE"]) {
    const refused = (await handle(new Request("https://app.test/mcp", { method }), {}))!;
    expect([method, refused.status, refused.headers.get("allow")]).toEqual([method, 405, "POST"]);
  }
  // A stateless 2025-era call carries no clientInfo; its revision is the header it sent.
  expect(
    events
      .filter(event => event.kind === "invocation" && event.phase === "completion")
      .map((event: any) => [event.client, event.protocolVersion]),
  ).toEqual([
    [undefined, LEGACY_REVISION],
    [undefined, LEGACY_REVISION],
    [undefined, LEGACY_REVISION],
  ]);
});

test("what neither era serves is refused: other revisions are observed, no refusal the client caused is logged", async () => {
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
    const claim = (version: string, method = "tools/list") =>
      mcpMessage(method, { _meta: { "io.modelcontextprotocol/protocolVersion": version } });
    // An envelope claiming a revision other than 2026-07-28: -32022, naming the one the envelope may claim.
    for (const version of ["2025-06-18", "2099-01-01"]) {
      const message = claim(version);
      const refused = (await post(message, { ...mcpHeaders(message), "mcp-protocol-version": version }))!;
      expect([version, refused.status]).toEqual([version, 400]);
      expect(await json(refused)).toMatchObject({
        id: 1,
        error: { code: -32022, data: { supported: [MCP_REVISION], requested: version } },
      });
    }
    // A 2025-era request whose MCP-Protocol-Version header names a revision the SDK does not support.
    const unsupported = (await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "mcp-protocol-version": "1999-01-01" },
    ))!;
    expect(unsupported.status).toBe(400);
    expect(events).toEqual(
      [0, 1, 2].map(() =>
        expect.objectContaining({
          kind: "request-refused",
          surface: "public",
          status: 400,
          reason: "protocol-version",
        }),
      ),
    );
    // Other refusals the client causes, none observed: a batch with a 2026-07-28 element, an `initialize` sent with a
    // 2026-07-28 header, a 2026-07-28 header without the envelope, headers that contradict the body, an invalid
    // envelope, a body that is not JSON.
    const listing = mcpMessage("tools/list");
    expect((await post([listing], mcpHeaders(listing)))!.status).toBe(400);
    expect((await post(legacyInitialize, { "mcp-protocol-version": MCP_REVISION }))!.status).toBe(400);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, mcpHeaders(listing)))!.status).toBe(400);
    expect((await post(listing, { ...mcpHeaders(listing), "mcp-method": "tools/call" }))!.status).toBe(400);
    const envelope = mcpMessage("tools/list", { _meta: { "io.modelcontextprotocol/clientInfo": "nobody" } });
    expect((await post(envelope, mcpHeaders(envelope)))!.status).toBe(400);
    expect((await post(listing, { ...mcpHeaders(listing), "content-type": "text/plain" }))!.status).toBe(415);
    expect(events).toHaveLength(3);
    expect(errors.mock.calls.filter(([text]) => String(text).includes("[mantle mcp]"))).toEqual([]);
    // A fault of the server is logged, in either era: two tools of one name fail to register.
    const faulty = mcp([...tools, ...tools] as never, { db: () => ({}), caller: () => ({ kind: "anonymous" }) });
    expect((await faulty(new Request("https://app.test/mcp", mcpInit(listing)), {}))!.status).toBe(500);
    expect(
      (await faulty(
        new Request("https://app.test/mcp", legacyInit({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
        {},
      ))!.status,
    ).toBe(500);
    expect(
      errors.mock.calls.filter(([text]) => String(text).includes("[mantle mcp]")).map(([, error]) => String(error)),
    ).toEqual([expect.stringContaining("echo"), expect.stringContaining("echo")]);
  } finally {
    errors.mockRestore();
  }
});

test("the official client connects in either era; the observation names its revision, and its client on 2026-07-28", async () => {
  for (const era of ERAS) {
    const events: McpObservation[] = [];
    const handle = mcp(tools as never, {
      db: () => ({}),
      caller: () => ({ kind: "anonymous" }),
      onObservation: event => void events.push(event),
    });
    const client = await mcpClient(handle, undefined, { name: "observed-client", version: "4.2", era });
    expect([era, client.getNegotiatedProtocolVersion()]).toEqual([era, era]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["echo"]);
    expect((await client.callTool({ name: "echo", arguments: {} })).structuredContent).toEqual({ ok: true });
    await client.close();
    const named = era === MCP_REVISION ? { name: "observed-client", version: "4.2" } : undefined;
    expect(events.filter(e => e.kind === "invocation").map((e: any) => [e.phase, e.client, e.protocolVersion])).toEqual(
      [
        ["attempt", named, era],
        ["completion", named, era],
      ],
    );
  }
  const discovered = await mcp(tools as never, { db: () => ({}), caller: () => ({ kind: "anonymous" }) })(
    new Request("https://app.test/mcp", mcpInit(mcpMessage("server/discover"))),
    {},
  );
  expect(discovered!.status).toBe(200);
});

test("a 2025-era initialize is a catalogue read: cookie authority may answer it from cache", async () => {
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
    handle(new Request("https://app.test/mcp", legacyInit(legacyInitialize, { headers: { cookie } })), {});
  expect((await post("session=valid"))!.status).toBe(200);
  // Without a session the closed surface challenges first, as it does any anonymous request.
  expect((await post("session=expired"))!.status).toBe(401);
  expect(hints).toEqual([true, true]);
});

/**
 * How the SDK routes a request (`classifyInboundRequest`, SDK 2.4.0) and what a host's forwarded request gets. The host
 * rule reads the method whichever era serves it, so no request the SDK would serve escapes it: notifications, a
 * header-only 2026-07-28 notification, an envelope that claims a 2025 revision, an `initialize` sent with a 2026-07-28
 * header.
 */
test("era classification and the host rule, request by request", async () => {
  const PINNED = "procedure:peek";
  const handTools: Tool<object>[] = ["peek", "poke"].map(name => ({
    name,
    surface: "public",
    readOnly: true,
    target: { kind: "procedure", name },
    description: name,
    inputSchema: { type: "object" },
    validate: raw => raw as Record<string, unknown>,
    run: async () => ({ ok: true }),
  }));
  const handle = mcp(handTools, {
    gateway: { tenant: "example" },
    accessTargets: async () => ({
      [PINNED]: { targetHash: "hash", opaque: false },
      "procedure:poke": { targetHash: "other", opaque: false },
    }),
    db: () => ({}),
  });
  const props = mantleProps({ target: PINNED, targetHash: "hash" });
  const legacyHeader = { "mcp-protocol-version": LEGACY_REVISION };
  const modern = (message: Record<string, unknown>) => ({ message, headers: mcpHeaders(message) });
  const plain = (message: unknown, headers: Record<string, string> = legacyHeader) => ({ message, headers });
  const claim2025 = mcpMessage("tools/call", {
    name: "peek",
    arguments: {},
    _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
  });
  const rows: [string, { message: unknown; headers: Record<string, string> }, string, number][] = [
    // [case, request, SDK route, host status]
    ["2025 initialize", plain(legacyInitialize, {}), "legacy:initialize", 200],
    [
      "2025 initialize with a 2026-07-28 header",
      plain(legacyInitialize, { "mcp-protocol-version": MCP_REVISION }),
      "reject:initialize-with-modern-header",
      400,
    ],
    ["2025 tools/list", plain({ jsonrpc: "2.0", id: 1, method: "tools/list" }), "legacy:no-claim", 403],
    ["2025 tools/call, the pinned tool", plain(call("peek")), "legacy:no-claim", 200],
    ["2025 tools/call, another tool", plain(call("poke")), "legacy:no-claim", 412],
    ["2025 notification", plain({ jsonrpc: "2.0", method: "notifications/initialized" }), "legacy:notification", 403],
    ["2025 batch", plain([call("peek")]), "legacy:batch", 400],
    ["2025 response posted", plain({ jsonrpc: "2.0", id: 1, result: {} }), "legacy:response", 202],
    ["2026-07-28 server/discover", modern(mcpMessage("server/discover")), "modern:2026-07-28", 200],
    [
      "2026-07-28 tools/call, the pinned tool",
      modern(mcpMessage("tools/call", { name: "peek", arguments: {} })),
      "modern:2026-07-28",
      200,
    ],
    [
      "2026-07-28 tools/call, another tool",
      modern(mcpMessage("tools/call", { name: "poke", arguments: {} })),
      "modern:2026-07-28",
      412,
    ],
    ["2026-07-28 tools/list", modern(mcpMessage("tools/list")), "modern:2026-07-28", 403],
    [
      "2026-07-28 header-only notification",
      plain({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": MCP_REVISION }),
      "modern:2026-07-28",
      403,
    ],
    [
      "envelope claiming 2025-06-18, the pinned tool",
      plain(claim2025, { ...mcpHeaders(claim2025), "mcp-protocol-version": "2025-06-18" }),
      "modern:2025-06-18",
      400,
    ],
    [
      "envelope claiming 2025-06-18, tools/list",
      plain(mcpMessage("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" } }), {}),
      "modern:2025-06-18",
      403,
    ],
    ["batch with a 2026-07-28 element", plain([mcpMessage("tools/list")], {}), "reject:batch-with-modern-element", 400],
  ];
  const table: [string, string, number][] = [];
  for (const [name, { message, headers }, route] of rows) {
    const outcome = classifyInboundRequest({
      httpMethod: "POST",
      ...(headers["mcp-protocol-version"] ? { protocolVersionHeader: headers["mcp-protocol-version"] } : {}),
      ...(headers["mcp-method"] ? { mcpMethodHeader: headers["mcp-method"] } : {}),
      ...(headers["mcp-name"] ? { mcpNameHeader: headers["mcp-name"] } : {}),
      body: message,
    } as Parameters<typeof classifyInboundRequest>[0]) as any;
    const routed =
      outcome.kind === "legacy"
        ? `legacy:${outcome.reason}`
        : outcome.kind === "modern"
          ? `modern:${outcome.classification.revision}`
          : `reject:${outcome.cell}`;
    const response = (await handle(
      new Request("https://app.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(message),
      }),
      {},
      { props: { mantle: props } } as never,
    ))!;
    table.push([name, routed, response.status]);
    expect([name, routed]).toEqual([name, route]);
  }
  expect(table).toEqual(rows.map(([name, , route, status]) => [name, route, status]));
});
