import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import { describe, expect, it, vi } from "vitest";
import { projectCallableCapabilities } from "../src/domain/service/CallableCapabilityProjector.js";
import { compileRuntimePlan, type RuntimePlan } from "../src/domain/service/RuntimePlanCompiler.js";
import type { HandlerContext } from "../src/domain/model/HandlerContext.js";
import { createMcpDispatcher, type McpDispatcherRuntime } from "../src/infrastructure/mcp/createMcpDispatcher.js";
import { MCP_PROTOCOL_VERSION, McpJsonRpcDispatcher } from "../src/infrastructure/mcp/McpJsonRpcDispatcher.js";

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
metadata: { name: staff-posts }
spec:
  surface: staff
  from: posts
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
metadata: { name: ping }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: ping }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: ping-staff }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: ping }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: http-only }
spec:
  requires:
    auth:
      all:
        - { "ctx.staff": [owner] }
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: http-only }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: http-only-http }
spec:
  source: { kind: http, method: POST, path: /api/http-only }
  target: { procedure: http-only }
`;

const purposes = [{ name: "post-cover", required: ["image/jpeg"], maxBytes: { "image/jpeg": 1 } }];

describe("createMcpDispatcher", () => {
  it("serves the same catalog as a hand-wired dispatcher for each surface", async () => {
    const plan = compile(manifest);
    const runtime = fakeRuntime(plan);
    for (const surface of ["staff", "public"] as const) {
      const handWired = new McpJsonRpcDispatcher({ ...runtime, media: undefined } as never, [...runtime.schemas.values()], {
        surface,
        capabilities: projectCallableCapabilities(plan, { surface }),
      });
      expect(await toolNames(createMcpDispatcher(runtime, plan, { surface })))
        .toEqual(await toolNames(handWired));
    }
    expect(await toolNames(createMcpDispatcher(runtime, plan, { surface: "public" })))
      .toEqual(["query_view_public_posts"]);
  });

  it("never exposes an HTTP-only staff Procedure", async () => {
    const plan = compile(manifest);
    const staff = await toolNames(createMcpDispatcher(fakeRuntime(plan), plan, { surface: "staff" }));
    expect(staff).toContain("ping");
    expect(staff).not.toContain("http_only");
  });

  it("serves media tools only with media storage and declared purposes", async () => {
    const plan = compile(manifest);
    const media = { createUpload: { execute: vi.fn() }, commitUpload: { execute: vi.fn() } };
    const withMedia = fakeRuntime(plan, media);
    const withoutMedia = fakeRuntime(plan, null);
    expect(await toolNames(createMcpDispatcher(withMedia, plan, { surface: "staff" })))
      .not.toContain("create_media_upload");
    expect(await toolNames(createMcpDispatcher(withMedia, plan, { surface: "staff", mediaPurposes: purposes })))
      .toEqual(expect.arrayContaining(["create_media_upload", "commit_media_upload"]));
    expect(await toolNames(createMcpDispatcher(withoutMedia, plan, { surface: "staff", mediaPurposes: purposes })))
      .not.toContain("create_media_upload");
  });

  it("routes View calls by View name and forwards serverInfo", async () => {
    const plan = compile(manifest);
    const runtime = fakeRuntime(plan);
    const dispatcher = createMcpDispatcher(runtime, plan, {
      surface: "public",
      serverInfo: { name: "aotter.mantle.public", title: "Example" },
    });
    const init = await (await dispatcher.dispatch(rpc("initialize"), context())).json() as {
      result: { serverInfo: { name: string; title: string } };
    };
    expect(init.result.serverInfo).toMatchObject({ name: "aotter.mantle.public", title: "Example" });
    await dispatcher.dispatch(rpc("tools/call", { name: "query_view_public_posts", arguments: {} }), context());
    expect(runtime.executeView).toHaveBeenCalledWith(expect.objectContaining({ view: "public-posts" }));
  });
});

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:mcp", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}

function fakeRuntime(
  plan: RuntimePlan,
  media: McpDispatcherRuntime["media"] | { createUpload: unknown; commitUpload: unknown } = null,
) {
  const unused = { execute: vi.fn() };
  return {
    schemas: new Map(Object.values(plan.schemas).map(({ manifest }) => [manifest.metadata.name, manifest])),
    getEntry: unused,
    createDraft: unused,
    updateDraft: unused,
    requestPublish: unused,
    unpublish: unused,
    archive: unused,
    deleteEntry: unused,
    executeView: vi.fn(async () => ({ ok: true as const, data: { rows: [], page: 1, show: 20, hasMore: false } })),
    invokeTrigger: vi.fn(async () => ({ ok: true as const, data: {} })),
    media,
  } as unknown as McpDispatcherRuntime & { executeView: ReturnType<typeof vi.fn> };
}

async function toolNames(dispatcher: McpJsonRpcDispatcher): Promise<string[]> {
  const body = await (await dispatcher.dispatch(rpc("tools/list"), context())).json() as {
    result: { tools: { name: string }[] };
  };
  return body.result.tools.map((tool) => tool.name);
}

function rpc(method: string, params?: unknown): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function context(): HandlerContext {
  return {
    user: { id: "u1" },
    staff: { id: "u1", role: "owner" },
    auth: { credential: "oauth", credentialId: null, clientId: "client-1", scopes: ["mcp"] },
    env: {},
  };
}
