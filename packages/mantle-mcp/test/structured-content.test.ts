import { describe, expect, it } from "vitest";
import type { HandlerContext } from "../../mantle-runtime/src/domain/model/HandlerContext.js";
import { McpJsonRpcDispatcher, MCP_PROTOCOL_VERSION, type McpUseCases } from "./dispatcherShim.js";
import type {
  ProcedureCallableCapability,
  ViewCallableCapability,
} from "../../mantle-runtime/src/domain/service/CallableCapabilityProjector.js";
import { makeProcedure, postsSchema, recentPostsView } from "../../mantle-runtime/test/fakes/manifests.js";

describe("MCP tools/call structuredContent", () => {
  it("adds structuredContent for object results and keeps the text block unchanged", async () => {
    const data = { id: "p1", title: "Hello" };
    const result = await call(harness(data), "echo");
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
    expect(result.structuredContent).toEqual(data);
  });

  it.each([[["a", "b"]], ["plain"], [7], [null]])("keeps only the text block for a non-object result %j", async (data) => {
    const result = await call(harness(data), "echo");
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("returns a View page as structuredContent", async () => {
    const page = { rows: [{ id: "p1" }], page: 1, show: 20, hasMore: false };
    const result = await call(harness({}, page), "query_view_recent_posts");
    expect(result.structuredContent).toEqual(page);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(page) }]);
  });

  it("advertises outputSchema only for projectable Procedure outputs", async () => {
    const listed = await rpc(new McpJsonRpcDispatcher(useCases({}), [postsSchema()], {
      surface: "public",
      capabilities: [
        procedure("echo", { type: "object", properties: { id: { type: "string" } } }),
        procedure("tags", { type: "object", properties: { tags: { type: "array", uniqueItems: true } } }),
        view(),
      ],
    }), "tools/list") as { tools: { name: string; outputSchema?: unknown }[] };
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("echo")?.outputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(byName.get("tags")).not.toHaveProperty("outputSchema");
    expect(byName.get("query_view_recent_posts")).not.toHaveProperty("outputSchema");
  });
});

function harness(procedureData: unknown, viewResult: unknown = { rows: [], page: 1, show: 20, hasMore: false }) {
  return new McpJsonRpcDispatcher(useCases(procedureData, viewResult), [postsSchema()], {
    surface: "public",
    // No declared output, so no outputSchema: these cases return arrays and
    // strings, which the SDK would refuse to send under an advertised
    // outputSchema (Runtime's output validation rejects them first in a real
    // plan).
    capabilities: [procedure("echo", {}), view()],
  });
}

function useCases(procedureData: unknown, viewResult: unknown = {}): McpUseCases {
  return {
    invokeTrigger: { execute: async () => ({ ok: true as const, data: procedureData }) },
    executeView: { execute: async () => ({ ok: true as const, result: viewResult }) as never },
  } as unknown as McpUseCases;
}

function procedure(name: string, output: ProcedureCallableCapability["outputSchema"]): ProcedureCallableCapability {
  const manifest = makeProcedure({ name, output });
  return {
    kind: "procedure",
    name,
    ownerName: name,
    trigger: `${name}-mcp`,
    surface: "public",
    description: `Invoke Procedure '${name}'.`,
    inputSchema: { type: "object" },
    outputSchema: output,
    manifest,
  };
}

function view(): ViewCallableCapability {
  const manifest = recentPostsView();
  return {
    kind: "view",
    name: "query_view_recent_posts",
    ownerName: manifest.metadata.name,
    surface: "public",
    description: "Query public View 'recent-posts'.",
    inputSchema: { type: "object" },
    manifest: { ...manifest, spec: { ...manifest.spec, surface: "public" } },
  };
}

async function call(dispatcher: McpJsonRpcDispatcher, name: string): Promise<Record<string, unknown>> {
  return await rpc(dispatcher, "tools/call", { name, arguments: {} }) as Record<string, unknown>;
}

async function rpc(dispatcher: McpJsonRpcDispatcher, method: string, params?: unknown): Promise<unknown> {
  const response = await dispatcher.dispatch(new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), context());
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (!("result" in body)) throw new Error(`unexpected error: ${JSON.stringify(body.error)}`);
  return body.result;
}

function context(): HandlerContext {
  return { user: null, staff: null, env: {} };
}
