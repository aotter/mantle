import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import {
  bindCapabilities,
  compileRuntimePlan,
  type AuditSink,
  type CapabilityRuntime,
  type HandlerContext,
  type McpToolCallAuditEvent,
  type RuntimePlan,
} from "@aotter/mantle-runtime";
import { describe, expect, it, vi } from "vitest";
import { createMantleMcpHandler, type MantleMcpHandlerOptions } from "../src/index.js";

const ORIGIN = "https://example.test";

const manifest = `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties:
      title: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: public-posts }
spec:
  surface: public
  from: posts
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: shaped }
spec:
  input: { type: object, properties: { echo: { type: string } } }
  output:
    type: object
    required: [id, status]
    properties:
      id: { type: string, format: uuid }
      status: { type: string, enum: [open, closed], default: open }
  handler: { kind: ref, ref: shaped }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: shaped-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: shaped }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: member-only }
spec:
  requires: { auth: { all: [ctx.user] } }
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: member }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: member-only-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: member-only }
`;

describe("createMantleMcpHandler with the official client", () => {
  for (const era of ["modern", "legacy"] as const) {
    describe(`${era} era`, () => {
      it("lists the catalog and returns structuredContent the client validates", async () => {
        const { client } = await connect(era, { invokeTrigger: async () => ({ ok: true, data: { id: "p1" } }) });
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(["member_only", "query_view_public_posts", "shaped"]);
        const shaped = tools.find((tool) => tool.name === "shaped");
        expect(shaped?.outputSchema).toMatchObject({ type: "object", required: ["id"] });
        const result = await client.callTool({ name: "shaped", arguments: { echo: "x" } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ id: "p1" });
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ id: "p1" }) }]);
      });

      it("returns business failures as isError results carrying the diagnostic", async () => {
        const diagnostic = { code: "CONFLICT", phase: "runtime", severity: "error", path: "MCP shaped", message: "Version moved." };
        const { client } = await connect(era, { invokeTrigger: async () => ({ ok: false, diagnostic }) });
        const result = await client.callTool({ name: "shaped", arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({ diagnostics: [diagnostic] });
        expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ diagnostics: [diagnostic] });
      });
    });
  }

  it("hides unexpected errors behind an opaque internal diagnostic", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = await connect("modern", { invokeTrigger: async () => { throw new Error("D1 binding detail"); } });
    const result = await client.callTool({ name: "shaped", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("D1 binding detail");
    expect(result.structuredContent).toMatchObject({ diagnostics: [{ code: "INTERNAL_ERROR", message: "Internal error." }] });
    spy.mockRestore();
  });

  it("answers an anonymous call to an identity-requiring tool with the adapter's challenge", async () => {
    const invokeTrigger = vi.fn();
    const events: McpToolCallAuditEvent[] = [];
    const { handler } = harness({ invokeTrigger }, {
      audit: sink(events),
      unauthenticated: () => new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="x"' } }),
    });
    const response = await handler.fetch(rpc("tools/call", { name: "member_only", arguments: { operationId: "op-1" } }), anonymous());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(invokeTrigger).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ tool: "member_only", outcome: "UNAUTHENTICATED", operationId: "op-1" })]);
  });

  it("lets a signed-in caller through to the tool", async () => {
    const invokeTrigger = vi.fn(async () => ({ ok: true as const, data: {} }));
    const { handler } = harness({ invokeTrigger });
    const response = await handler.fetch(rpc("tools/call", { name: "member_only", arguments: {} }), member());
    expect(response.status).toBe(200);
    expect(invokeTrigger).toHaveBeenCalledWith(expect.objectContaining({ ctx: member() }));
  });

  it("audits every call, including probes for unknown tools", async () => {
    const events: McpToolCallAuditEvent[] = [];
    const { handler } = harness({ invokeTrigger: async () => ({ ok: true, data: {} }) }, { audit: sink(events) });
    await handler.fetch(rpc("tools/call", { name: "shaped", arguments: {} }), member());
    const probe = await handler.fetch(rpc("tools/call", { name: "ghost", arguments: { operationId: "p" } }), member());
    const body = await jsonRpcBody(probe) as { error?: { code: number } };
    expect(body.error?.code).toBeLessThan(0);
    expect(events).toEqual([
      expect.objectContaining({ tool: "shaped", outcome: "ok", surface: "public", callerId: "m1" }),
      expect.objectContaining({ tool: "ghost", outcome: "UNKNOWN_TOOL", operationId: "p" }),
    ]);
  });

  it("refuses non-JSON POSTs and oversized bodies before any tool runs", async () => {
    const invokeTrigger = vi.fn();
    const { handler } = harness({ invokeTrigger }, { maxRequestBodySize: 64 });
    const form = await handler.fetch(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    }), member());
    expect(form.status).toBe(415);
    const large = await handler.fetch(rpc("tools/call", { name: "shaped", arguments: { echo: "x".repeat(200) } }), member());
    expect(large.status).toBe(413);
    expect(invokeTrigger).not.toHaveBeenCalled();
  });
});

interface Fakes {
  readonly invokeTrigger?: (request: never) => Promise<unknown>;
  readonly executeView?: (request: never) => Promise<unknown>;
}

function harness(fakes: Fakes, options: MantleMcpHandlerOptions = {}) {
  const plan = compile(manifest);
  const unused = { execute: vi.fn() };
  const runtime = {
    schemas: new Map(Object.values(plan.schemas).map(({ manifest }) => [manifest.metadata.name, manifest])),
    getEntry: unused,
    createDraft: unused,
    updateDraft: unused,
    requestPublish: unused,
    unpublish: unused,
    archive: unused,
    deleteEntry: unused,
    executeView: fakes.executeView ?? (async () => ({ ok: true, result: { rows: [], page: 1, show: 20, hasMore: false } })),
    invokeTrigger: fakes.invokeTrigger ?? (async () => ({ ok: true, data: {} })),
    media: null,
  } as unknown as CapabilityRuntime;
  const invoker = bindCapabilities(runtime, plan, { surface: "public" });
  return { handler: createMantleMcpHandler(invoker, { serverInfo: { name: "aotter.mantle.test" }, ...options }) };
}

async function connect(era: "modern" | "legacy", fakes: Fakes) {
  const { handler } = harness(fakes);
  const methods: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST") methods.push(((await request.clone().json()) as { method?: string }).method ?? "");
    return handler.fetch(request, member());
  };
  // The official client speaks 2025 unless told otherwise.
  const client = new Client(
    { name: "mantle-test", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: fetchImpl }));
  // The 2025 handshake starts with initialize; the 2026-07-28 era has none.
  expect(methods.includes("initialize")).toBe(era === "legacy");
  return { client };
}

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:mcp", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}

function rpc(method: string, params?: unknown): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** A 2025-era stateless answer may be framed as a one-event SSE stream. */
async function jsonRpcBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("")
    : text;
  return JSON.parse(data) as unknown;
}

function sink(events: McpToolCallAuditEvent[]): AuditSink {
  return { record: (event) => { events.push(event); } };
}

function member(): HandlerContext {
  return { user: { id: "m1" }, staff: null, auth: { credential: "oauth", credentialId: null, clientId: "c1", scopes: ["mcp"] }, env: {} };
}

function anonymous(): HandlerContext {
  return { user: null, staff: null, env: {} };
}
