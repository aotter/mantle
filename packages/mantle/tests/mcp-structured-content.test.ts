/**
 * Non-object `structuredContent` (SEP-2106), per era. On 2026-07-28 a tool lists its outputSchema whatever its root type
 * and a success sends its data, any JSON value, as `structuredContent` beside the JSON text block; the official client
 * validates it against the listed schema. On a 2025 revision structured content is an object: a tool whose data is not
 * one lists no outputSchema and sends its text block alone.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { generateOrThrow, writeGenerated } from "./apps/link.js";
import { sdkFixtureCaller, fixtureCaller } from "./apps/fixtures.js";
import { versionOf } from "../src/usecase/tool-version.js";
import { mcpClient } from "./mcp-client.js";
import { ERAS, LEGACY_REVISION, legacyInit } from "./mcp-wire.js";

const tool = (name: string, value: () => unknown, outputSchema?: object) => ({
  name,
  surface: "public",
  description: name,
  inputSchema: { type: "object" },
  validate: (raw: any) => raw,
  run: async () => value(),
  ...(outputSchema ? { outputSchema } : {}),
});
// Each tool returns a value its schema allows.
const conforming = [
  tool("array", () => ["a", "b"], { type: "array", items: { type: "string" } }),
  tool("text", () => "hello", { type: "string" }),
  tool("count", () => 3, { type: "integer" }),
  tool("ratio", () => 0.5, { type: "number" }),
  tool("flag", () => false, { type: "boolean" }),
  tool("nothing", () => null, { type: "null" }),
  tool("maybe", () => null, { type: "string", nullable: true }),
  tool("either", () => null, { type: ["string", "null"] }),
  tool("record", () => ({ id: "r1" }), { type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
  // A root without `type` the SDK cannot prove object-shaped is listed as authored, so the root guard admits any value.
  tool("mixed", () => ["a"], { anyOf: [{ type: "array" }, { type: "object" }] }),
  tool("referenced", () => ["a"], {
    $ref: "#/$defs/list",
    $defs: { list: { type: "array", items: { type: "string" } } },
  }),
  // No schema: the value is still structured content, `null` included.
  tool("loose", () => [1, 2]),
  tool("blank", () => null),
];

test("every tool lists its outputSchema whatever its root, and sends its data as structuredContent the client validates", async () => {
  const { mcp } = await import("../src/kernel/mcp.js");
  const handle = mcp(conforming as never, { db: () => ({}), caller: () => ({ kind: "anonymous" }) });
  const client = await mcpClient(handle);
  // The official client keeps each listed outputSchema and validates structuredContent against it on every call.
  const listed: Record<string, unknown> = Object.fromEntries(
    (await client.listTools()).tools.map(t => [t.name, t.outputSchema]),
  );
  for (const { name, outputSchema } of conforming) expect([name, listed[name]]).toEqual([name, outputSchema]);
  for (const { name, run } of conforming) {
    const value = await run();
    const result = await client.callTool({ name, arguments: {} });
    expect([name, result.isError]).toEqual([name, undefined]);
    expect((result.content as { text: string }[])[0]!.text).toBe(JSON.stringify(value));
    expect([name, result.structuredContent]).toEqual([name, value]);
  }
  await client.close();
});

test("on a 2025 revision a non-object tool lists no outputSchema and sends text only, never the SDK's { result } wrap; versions match", async () => {
  const { mcp } = await import("../src/kernel/mcp.js");
  const objectish = tool("objectish", () => ({ id: "o" }), { anyOf: [{ type: "object" }, { properties: {} }] });
  const tools = [...conforming, objectish];
  const handle = mcp(tools as never, { db: () => ({}), caller: () => ({ kind: "anonymous" }) });
  // The raw wire, so nothing a client normalises hides a wrap.
  const raw = async (body: unknown) => {
    const response = (await handle(new Request("https://app.test/mcp", legacyInit(body)), {}))!;
    const text = await response.text();
    return { text, body: JSON.parse(text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text) };
  };
  const listing = await raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(listing.text).not.toContain('"result":{"type"');
  const listed = Object.fromEntries(listing.body.result.tools.map((t: any) => [t.name, t.outputSchema]));
  // Only a root the SDK lists as an object stays: an object schema, and a typeless root it proves object-shaped.
  expect(Object.entries(listed).filter(([, schema]) => schema !== undefined)).toEqual([
    ["record", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }],
    ["objectish", { type: "object", anyOf: [{ type: "object" }, { properties: {} }] }],
  ]);
  for (const { name, run } of tools) {
    const value = await run();
    const { body } = await raw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    expect([name, body.result.isError]).toEqual([name, undefined]);
    expect([name, body.result.content[0].text]).toEqual([name, JSON.stringify(value)]);
    const object = typeof value === "object" && value !== null && !Array.isArray(value);
    // An object is structured content as on 2026-07-28; anything else is the text block alone.
    expect([name, body.result.structuredContent]).toEqual([name, object ? value : undefined]);
  }
  // The official client in its 2025 mode validates what it is given, and the tool version does not depend on the era.
  const descriptions: Record<string, string>[] = [];
  for (const era of ERAS) {
    const client = await mcpClient(handle, undefined, { era });
    const { tools: seen } = await client.listTools();
    descriptions.push(Object.fromEntries(seen.map(t => [t.name, t.description!])));
    for (const { name } of tools)
      expect([era, name, (await client.callTool({ name, arguments: {} })).isError]).toEqual([era, name, undefined]);
    await client.close();
  }
  expect(descriptions[0]).toEqual(descriptions[1]!);
});

test("a success the listed schema's root does not admit fails before it is recorded; a failure omits structuredContent only under a schema", async () => {
  const { mcp } = await import("../src/kernel/mcp.js");
  const tools = [
    // A listed schema requires structuredContent: `undefined` has none, so a tool returning nothing under a schema fails.
    tool("missing", () => undefined, { type: "string" }),
    // Values the listed schema's root type refuses.
    tool("unshaped", () => [1], { type: "object" }),
    tool("wrong", () => "3", { type: "integer" }),
    tool("fraction", () => 1.5, { type: "integer" }),
    tool("unexpected", () => null, { type: "string" }),
    // A typeless root the SDK proves object-shaped is listed with `type: "object"`, which an array does not fit.
    tool("objectish", () => [1], { anyOf: [{ type: "object" }, { properties: {} }] }),
    // Without a schema, nothing is required: a tool returning nothing answers JSON text alone.
    tool("silent", () => undefined),
    tool(
      "broken",
      () => {
        throw new Error("boom");
      },
      { type: "array" },
    ),
    tool("thrown", () => {
      throw new Error("boom");
    }),
  ];
  const completions: any[] = [];
  const handle = mcp(tools as never, {
    db: () => ({}),
    caller: () => ({ kind: "anonymous" }),
    onObservation: event => {
      if (event.kind === "invocation" && event.phase === "completion")
        completions.push([event.tool, event.outcome, event.code]);
    },
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    const client = await mcpClient(handle);
    const listed = (await client.listTools()).tools;
    expect(listed.find(t => t.name === "objectish")!.outputSchema).toEqual({
      type: "object",
      anyOf: [{ type: "object" }, { properties: {} }],
    });
    for (const name of ["missing", "unshaped", "wrong", "fraction", "unexpected", "objectish"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect([name, result.isError]).toEqual([name, true]);
      expect(JSON.parse((result.content as { text: string }[])[0]!.text).diagnostics[0].code).toBe("INTERNAL_ERROR");
      // The tool lists a schema, so its failure carries no structuredContent the schema would refuse.
      expect([name, "structuredContent" in result]).toEqual([name, false]);
    }
    const silent = await client.callTool({ name: "silent", arguments: {} });
    expect(silent.isError).toBeUndefined();
    expect(silent.content).toEqual([{ type: "text", text: "null" }]);
    expect("structuredContent" in silent).toBe(false);
    const broken = await client.callTool({ name: "broken", arguments: {} });
    expect(broken.isError).toBe(true);
    expect("structuredContent" in broken).toBe(false);
    const thrown = await client.callTool({ name: "thrown", arguments: {} });
    expect((thrown.structuredContent as any).diagnostics[0].code).toBe("INTERNAL_ERROR");
    await client.close();
  } finally {
    console.error = quiet;
  }
  expect(completions).toEqual([
    ["missing", "failed", "INTERNAL_ERROR"],
    ["unshaped", "failed", "INTERNAL_ERROR"],
    ["wrong", "failed", "INTERNAL_ERROR"],
    ["fraction", "failed", "INTERNAL_ERROR"],
    ["unexpected", "failed", "INTERNAL_ERROR"],
    ["objectish", "failed", "INTERNAL_ERROR"],
    ["silent", "succeeded", undefined],
    ["broken", "failed", "INTERNAL_ERROR"],
    ["thrown", "failed", "INTERNAL_ERROR"],
  ]);
});

const refSource = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: items}
spec:
  title: Items
  lifecycle: operational
  schema: {type: object, properties: {title: {type: string}}, required: [title]}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: titles}
spec:
  description: Item titles
  input: {type: object, additionalProperties: false}
  output: {type: array, items: {type: string}}
  handler: {ref: app.titles}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: {name: total}
spec:
  description: Item count
  input: {type: object, additionalProperties: false}
  output: {type: integer, nullable: true}
  handler: {ref: app.total}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: titles-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: titles}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: {name: total-mcp}
spec: {source: {kind: mcp, surface: public}, target: {procedure: total}}
`;

test("a ref Procedure with a non-object output lists its schema, sends its data (a withResult wrapper's too), and hashes the schema into its version", async () => {
  const files = await generateOrThrow("bun-sqlite", [{ sourceId: "ref-array.yaml", text: refSource }]);
  const { withResult } = await import("../src/kernel/mcp.js");
  const dir = await mkdtemp(resolve(import.meta.dir, ".mcp-structured-")),
    db = new Database(":memory:");
  const handlers = {
    titles: async () => withResult(["a", "b"], { _meta: { "example/count": 2 } }),
    total: async () => null,
  };
  try {
    await writeGenerated(dir, files);
    db.exec(files["schema.sql"]!);
    const { mcp, tools: generated } = await import(resolve(dir, "mcp.ts"));
    expect(generated.map((t: any) => [t.name, t.outputSchema])).toEqual([
      ["titles", { type: "array", items: { type: "string" } }],
      ["total", { type: "integer", nullable: true }],
    ]);
    const caller = sdkFixtureCaller(
      fixtureCaller({
        kind: "user",
        subject: "u",
        role: "admin",
        admin: true,
        scopes: ["mcp"],
        credential: "oauth",
        credentialId: null,
        clientId: null,
      }),
    );
    const client = await mcpClient(mcp({ db: () => db, caller: () => caller, handlers }));
    for (const listed of (await client.listTools()).tools) {
      const [, text, version] = /^(.*) \(tool version ([0-9a-f]{8})\)$/s.exec(listed.description!)!;
      const { name, title, inputSchema, outputSchema, annotations } = listed;
      expect(outputSchema).toEqual(generated.find((t: any) => t.name === name).outputSchema);
      // The version hashes the definition as listed, its output schema included.
      expect(versionOf({ name, title, description: text, inputSchema, outputSchema, annotations })).toBe(version!);
    }
    const titles = await client.callTool({ name: "titles", arguments: {} });
    expect((titles.content as { text: string }[])[0]!.text).toBe('["a","b"]');
    expect(titles.structuredContent).toEqual(["a", "b"]);
    expect(titles._meta).toMatchObject({ "example/count": 2 });
    const total = await client.callTool({ name: "total", arguments: {} });
    expect(total.isError).toBeUndefined();
    expect(total.structuredContent).toBeNull();
    const modern = (await client.listTools()).tools;
    await client.close();
    // On a 2025 revision: the same tools and versions, no non-object schema, the text block alone.
    const legacy = await mcpClient(mcp({ db: () => db, caller: () => caller, handlers }), undefined, {
      era: LEGACY_REVISION,
    });
    const listed = (await legacy.listTools()).tools;
    expect(listed.map(t => [t.name, t.description, t.outputSchema])).toEqual(
      modern.map(t => [t.name, t.description, undefined]),
    );
    const legacyTitles = await legacy.callTool({ name: "titles", arguments: {} });
    expect((legacyTitles.content as unknown[])[0]).toEqual({ type: "text", text: '["a","b"]' });
    expect(legacyTitles.structuredContent).toBeUndefined();
    expect(legacyTitles._meta).toMatchObject({ "example/count": 2 });
    expect((await legacy.callTool({ name: "total", arguments: {} })).structuredContent).toBeUndefined();
    await legacy.close();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
