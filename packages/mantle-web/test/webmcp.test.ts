import { describe, expect, it, vi } from "vitest";
import type {
  ProcedureCallableCapability,
  RuntimeCallableCapability,
  ViewCallableCapability,
} from "@aotter/mantle-runtime";
import {
  bindWebMcp,
  type BindWebMcpOptions,
  type WebMcpCall,
  type WebMcpTool,
} from "../src/webmcp.js";
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

function publicProcedure(
  name: string,
  readOnly: boolean,
): ProcedureCallableCapability {
  const manifest = makeProcedure({
    name,
    input: {
      type: "object",
      properties: { value: { type: "string" } },
      ...(readOnly ? { readOnly: true } : {}),
    },
  });
  return {
    kind: "procedure",
    name: name.replaceAll("-", "_"),
    ownerName: name,
    trigger: `${name}-mcp`,
    surface: "public",
    description: `Invoke '${name}'.`,
    inputSchema: manifest.spec.input,
    outputSchema: manifest.spec.output,
    manifest,
  };
}

describe("bindWebMcp", () => {
  it("feature-detects unsupported browsers without invoking capabilities", async () => {
    await expect(bindWebMcp()).resolves.toMatchObject({
      supported: false,
      registered: [],
      skipped: [],
    });
  });

  it("registers public Views and Procedures with canonical annotations", async () => {
    const registrations: Array<{ tool: WebMcpTool; signal: AbortSignal }> = [];
    const capabilities: RuntimeCallableCapability[] = [
      publicView(),
      { ...publicView(), name: "staff", surface: "staff" },
      publicProcedure("inspect-companion", true),
      publicProcedure("submit-companion-action", false),
    ];
    const binding = await bindWebMcp({
      capabilities,
      invoke: async () => null,
      modelContext: {
        registerTool: (tool, { signal }) => registrations.push({ tool, signal }),
      },
    });

    expect(binding).toMatchObject({
      supported: true,
      registered: [
        "query_view_recent_posts",
        "inspect_companion",
        "submit_companion_action",
      ],
      skipped: [],
    });
    expect(registrations.map(({ tool }) => [tool.name, tool.annotations])).toEqual([
      ["query_view_recent_posts", { readOnlyHint: true, untrustedContentHint: true }],
      ["inspect_companion", { readOnlyHint: true }],
      ["submit_companion_action", { readOnlyHint: false }],
    ]);
    expect(registrations.every(({ signal }) => !signal.aborted)).toBe(true);
    binding.dispose();
    expect(registrations.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("keeps existing host tools and reports inspected collisions", async () => {
    const registered: string[] = [];
    const binding = await bindWebMcp({
      capabilities: [publicView(), publicProcedure("inspect-companion", true)],
      invoke: async () => null,
      modelContext: {
        getTools: () => [
          { name: "host-owned" },
          { name: "query_view_recent_posts" },
        ],
        registerTool: (tool) => registered.push(tool.name),
      },
    });

    expect(binding.registered).toEqual(["inspect_companion"]);
    expect(binding.skipped).toEqual(["query_view_recent_posts"]);
    expect(registered).toEqual(["inspect_companion"]);
  });

  it("passes local results, signals, and minimal call context through hooks", async () => {
    const tools: WebMcpTool[] = [];
    const calls: WebMcpCall[] = [];
    const outcomes: PromiseSettledResult<unknown>[] = [];
    const invoke = vi.fn(async (_capability, input, signal) => ({ input, signal }));
    await bindWebMcp({
      capabilities: [publicProcedure("inspect-companion", true)],
      invoke,
      before: (call) => calls.push(call),
      after: (_call, result) => outcomes.push(result),
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });
    const invocation = new AbortController();
    const input = { value: "hello" };
    const result = await tools[0]!.execute(input, { signal: invocation.signal });

    expect(result).toEqual({ input, signal: invocation.signal });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "inspect-companion-mcp" }),
      input,
      invocation.signal,
    );
    expect(calls).toEqual([{
      name: "inspect_companion",
      target: { kind: "procedure", name: "inspect-companion" },
      input,
      signal: invocation.signal,
    }]);
    expect(outcomes).toEqual([{ status: "fulfilled", value: result }]);
  });

  it("resolves the current local Runtime for View and Trigger invocation", async () => {
    const tools: WebMcpTool[] = [];
    const first = {
      executeView: vi.fn(),
      invokeTrigger: vi.fn(async () => ({ ok: true, data: "first-trigger" })),
    };
    const second = {
      executeView: vi.fn(async () => ({ ok: true, result: "second-view" })),
      invokeTrigger: vi.fn(),
    };
    let current = first;
    await bindWebMcp({
      capabilities: [publicView(), publicProcedure("inspect-companion", true)],
      invoke: async (capability, input) => {
        const runtime = current;
        if (capability.kind === "procedure") {
          const result = await runtime.invokeTrigger({
            trigger: capability.trigger,
            input,
            ctx: {},
          });
          if (!result?.ok) throw new Error("Trigger failed");
          return result.data;
        }
        const result = await runtime.executeView({
          view: capability.ownerName,
          options: { params: input },
          ctx: {},
        });
        if (!result?.ok) throw new Error("View failed");
        return result.result;
      },
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });

    await expect(tools[1]!.execute({ value: "a" }, {})).resolves.toBe("first-trigger");
    current = second;
    await expect(tools[0]!.execute({ locale: "en" }, {})).resolves.toBe("second-view");
    expect(first.invokeTrigger).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "inspect-companion-mcp",
    }));
    expect(second.executeView).toHaveBeenCalledWith(expect.objectContaining({
      view: "recent-posts",
    }));
  });

  it("preserves invocation failures even when the observational after hook rejects", async () => {
    const tools: WebMcpTool[] = [];
    const failure = new Error("domain failed");
    const outcomes: PromiseSettledResult<unknown>[] = [];
    await bindWebMcp({
      capabilities: [publicProcedure("submit-companion-action", false)],
      invoke: async () => { throw failure; },
      after: (_call, result) => {
        outcomes.push(result);
        throw new Error("navigation failed");
      },
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });

    await expect(tools[0]!.execute({}, {})).rejects.toBe(failure);
    expect(outcomes).toEqual([{ status: "rejected", reason: failure }]);
  });

  it("runs after with a rejected result when before vetoes invocation", async () => {
    const tools: WebMcpTool[] = [];
    const veto = new Error("blocked by host");
    const invoke = vi.fn();
    const outcomes: PromiseSettledResult<unknown>[] = [];
    await bindWebMcp({
      capabilities: [publicProcedure("submit-companion-action", false)],
      invoke,
      before: () => { throw veto; },
      after: (_call, result) => outcomes.push(result),
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });

    await expect(tools[0]!.execute({}, {})).rejects.toBe(veto);
    expect(invoke).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ status: "rejected", reason: veto }]);
  });

  it("reports invocation cancellation to after without calling before", async () => {
    const tools: WebMcpTool[] = [];
    const before = vi.fn();
    const outcomes: PromiseSettledResult<unknown>[] = [];
    const invocation = new AbortController();
    invocation.abort();
    await bindWebMcp({
      capabilities: [publicProcedure("inspect-companion", true)],
      invoke: vi.fn(),
      before,
      after: (_call, result) => outcomes.push(result),
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });

    await expect(tools[0]!.execute({}, { signal: invocation.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(before).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: { name: "AbortError" },
    });
  });

  it("keeps registration teardown separate from invocation cancellation", async () => {
    const tools: WebMcpTool[] = [];
    let invocationSignal: AbortSignal | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let ready!: () => void;
    const invocationStarted = new Promise<void>((resolve) => { ready = resolve; });
    const binding = await bindWebMcp({
      capabilities: [publicProcedure("inspect-companion", true)],
      invoke: async (_capability, _input, signal) => {
        invocationSignal = signal;
        ready();
        await finished;
        return "done";
      },
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });
    const invocation = new AbortController();
    const pending = tools[0]!.execute({}, { signal: invocation.signal });
    await invocationStarted;

    binding.dispose();
    expect(invocationSignal?.aborted).toBe(false);
    invocation.abort();
    expect(invocationSignal?.aborted).toBe(true);
    finish();
    await expect(pending).resolves.toBe("done");
  });

  it("discovers and invokes server-backed public Views", async () => {
    const tools: WebMcpTool[] = [];
    const requests: Array<{ input: RequestInfo | URL; signal?: AbortSignal }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, signal: init?.signal ?? undefined });
      return input === "/api/views"
        ? Response.json({
            ok: true,
            data: [{
              name: "query_view_recent_posts",
              target: { kind: "view", name: "recent-posts" },
              description: "Query public View 'recent-posts'.",
              inputSchema: { type: "object" },
              manifest: { should: "not cross the trust boundary" },
            }],
          })
        : Response.json({ ok: true, data: { rows: [{ title: "Hello" }] } });
    });
    const binding = await bindWebMcp({
      modelContext: { registerTool: (tool) => tools.push(tool) },
      fetch: fetcher as typeof fetch,
    });
    const invocation = new AbortController();

    await expect(tools[0]!.execute(
      { locale: "zh-TW", page: 2, ignored: { nested: true } },
      { signal: invocation.signal },
    )).resolves.toEqual({ rows: [{ title: "Hello" }] });
    expect(binding.registered).toEqual(["query_view_recent_posts"]);
    expect(tools[0]).not.toHaveProperty("manifest");
    expect(requests.map(({ input }) => input)).toEqual([
      "/api/views",
      "/api/views/recent-posts?locale=zh-TW&page=2",
    ]);
    expect(requests[1]!.signal).toBe(invocation.signal);
  });

  it("rejects malformed server catalogs before registration", async () => {
    const registerTool = vi.fn();
    await expect(bindWebMcp({
      modelContext: { registerTool },
      fetch: vi.fn(async () => Response.json({ ok: true, data: [{ name: "unsafe" }] })),
    })).rejects.toThrow("catalog contains an invalid View");
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("rejects an unavailable server catalog", async () => {
    await expect(bindWebMcp({
      modelContext: { registerTool: vi.fn() },
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    })).rejects.toThrow("Mantle WebMCP catalog failed (503)");
  });

  it("requires local capabilities and invoke together", async () => {
    await expect(bindWebMcp({
      capabilities: [publicView()],
      modelContext: { registerTool: vi.fn() },
    } as BindWebMcpOptions)).rejects.toThrow(
      "capabilities and invoke must be provided together",
    );
  });

  it.each([
    "https://other.example/views",
    "//other.example/views",
    "/\\other.example/views",
  ])("rejects unsafe server endpoint override %s before fetching", async (endpointPrefix) => {
    const fetcher = vi.fn();
    await expect(bindWebMcp({
      endpointPrefix,
      fetch: fetcher,
      modelContext: { registerTool: vi.fn() },
    })).rejects.toThrow("same-origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let registration disposal cancel a server invocation", async () => {
    const tools: WebMcpTool[] = [];
    let requestSignal: AbortSignal | undefined;
    let finish!: () => void;
    const finished = new Promise<Response>((resolve) => {
      finish = () => resolve(Response.json({ ok: true, data: "done" }));
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/views") {
        return Response.json({
          ok: true,
          data: [{
            name: "query_view_recent_posts",
            target: { kind: "view", name: "recent-posts" },
            description: "Query recent posts.",
            inputSchema: { type: "object" },
          }],
        });
      }
      requestSignal = init?.signal ?? undefined;
      return await finished;
    });
    const binding = await bindWebMcp({
      modelContext: { registerTool: (tool) => tools.push(tool) },
      fetch: fetcher as typeof fetch,
    });
    const pending = tools[0]!.execute({}, {});
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    binding.dispose();
    expect(requestSignal?.aborted).toBe(false);
    finish();
    await expect(pending).resolves.toBe("done");
  });

  it("rolls back this binding when registration fails without inspection", async () => {
    let signal: AbortSignal | undefined;
    await expect(bindWebMcp({
      capabilities: [publicView()],
      invoke: async () => null,
      modelContext: {
        registerTool: (_tool, options) => {
          signal = options.signal;
          throw Object.assign(new Error("duplicate tool"), { name: "InvalidStateError" });
        },
      },
    })).rejects.toThrow("duplicate tool");
    expect(signal?.aborted).toBe(true);
  });

  it("rejects duplicate projected names before registration", async () => {
    const registerTool = vi.fn();
    await expect(bindWebMcp({
      capabilities: [publicView(), publicView()],
      invoke: async () => null,
      modelContext: { registerTool },
    })).rejects.toThrow("Duplicate WebMCP capability name 'query_view_recent_posts'");
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("rejects non-object invocation input before hooks or dispatch", async () => {
    const tools: WebMcpTool[] = [];
    const invoke = vi.fn();
    const before = vi.fn();
    await bindWebMcp({
      capabilities: [publicView()],
      invoke,
      before,
      modelContext: { registerTool: (tool) => tools.push(tool) },
    });

    await expect(tools[0]!.execute([] as never, {})).rejects.toThrow(
      "WebMCP tool input must be an object",
    );
    expect(before).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
