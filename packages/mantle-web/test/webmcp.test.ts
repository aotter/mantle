import { describe, expect, it, vi } from "vitest";
import type {
  ProcedureCallableCapability,
  RuntimeCallableCapability,
  ViewCallableCapability,
} from "@aotter/mantle-runtime";
import {
  bindWebMcp,
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
    const invoke = vi.fn();
    await expect(bindWebMcp({
      capabilities: [publicView()],
      invoke,
    })).resolves.toMatchObject({
      supported: false,
      registered: [],
      skipped: [],
    });
    expect(invoke).not.toHaveBeenCalled();
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
