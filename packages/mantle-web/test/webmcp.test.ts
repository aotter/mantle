import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeCallableCapability,
  ViewCallableCapability,
} from "@aotter/mantle-runtime";
import { bindWebMcp, type WebMcpTool } from "../src/webmcp.js";
import { makeProcedure, recentPostsView } from "../../mantle-runtime/test/fakes/manifests.js";

function publicView(): ViewCallableCapability {
  const manifest = recentPostsView();
  return {
    kind: "view",
    name: "query_view_recent_posts",
    ownerName: "recent-posts",
    surface: "public",
    description: "Query public View 'recent-posts'.",
    inputSchema: { type: "object", properties: { page: { type: "number" } } },
    manifest,
  };
}

describe("bindWebMcp", () => {
  it("feature-detects unsupported browsers without side effects", async () => {
    await expect(bindWebMcp([publicView()])).resolves.toMatchObject({
      supported: false,
      registered: [],
    });
  });

  it("registers only public Views and disposes them through AbortSignal", async () => {
    const registrations: Array<{ tool: WebMcpTool; signal: AbortSignal }> = [];
    const procedure = makeProcedure({ name: "mutate" });
    const capabilities: RuntimeCallableCapability[] = [
      publicView(),
      { ...publicView(), name: "staff", surface: "staff" },
      {
        kind: "procedure",
        name: "mutate",
        ownerName: "mutate",
        trigger: "mutate-mcp",
        surface: "public",
        description: "Mutate.",
        inputSchema: procedure.spec.input,
        outputSchema: procedure.spec.output,
        manifest: procedure,
      },
    ];
    const binding = await bindWebMcp(capabilities, {
      modelContext: {
        registerTool: (tool, { signal }) => registrations.push({ tool, signal }),
      },
    });

    expect(binding).toMatchObject({ supported: true, registered: ["query_view_recent_posts"] });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.tool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(registrations[0]!.signal.aborted).toBe(false);
    binding.dispose();
    expect(registrations[0]!.signal.aborted).toBe(true);
  });

  it("calls the same-origin View endpoint with cancellation", async () => {
    const tools: WebMcpTool[] = [];
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Response.json({
        ok: true,
        data: { rows: [{ title: "Hello" }], page: 2, show: 10, hasMore: false },
      });
    });
    await bindWebMcp([publicView()], {
      modelContext: { registerTool: (tool) => tools.push(tool) },
      fetch,
    });
    const invocation = new AbortController();
    await expect(tools[0]!.execute(
      { locale: "zh-TW", page: 2, ignored: { nested: true } },
      { signal: invocation.signal },
    )).resolves.toMatchObject({ rows: [{ title: "Hello" }] });

    expect(fetch).toHaveBeenCalledWith(
      "/api/views/recent-posts?locale=zh-TW&page=2",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
    invocation.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("aborts in-flight calls when the binding is disposed", async () => {
    const tools: WebMcpTool[] = [];
    let requestSignal: AbortSignal | undefined;
    const binding = await bindWebMcp([publicView()], {
      modelContext: { registerTool: (tool) => tools.push(tool) },
      fetch: vi.fn((_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    });
    void tools[0]!.execute({}, { signal: new AbortController().signal });
    binding.dispose();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("aborts partial registration when the browser rejects a tool", async () => {
    let signal: AbortSignal | undefined;
    await expect(bindWebMcp([publicView()], {
      modelContext: {
        registerTool: (_tool, options) => {
          signal = options.signal;
          throw new Error("duplicate tool");
        },
      },
    })).rejects.toThrow("duplicate tool");
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    "https://other.example/views",
    "//other.example/views",
    "/\\other.example/views",
  ])("rejects unsafe endpoint override %s", async (endpointPrefix) => {
    const tools: WebMcpTool[] = [];
    await bindWebMcp([publicView()], {
      modelContext: { registerTool: (tool) => tools.push(tool) },
      endpointPrefix,
    });
    await expect(tools[0]!.execute({}, {})).rejects.toThrow("same-origin");
  });
});
