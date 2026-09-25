import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE, EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { linkManifestSet, parseManifestSources } from "@aotter/mantle-spec";
import {
  bindCapabilities,
  compileRuntimePlan,
  type CapabilityRuntime,
  type HandlerContext,
  type McpToolCallAuditEvent,
  type RuntimePlan,
} from "@aotter/mantle-runtime";
import { describe, expect, it, vi } from "vitest";
import { clientUiSupport, createMantleMcpHandler, type MantleMcpApps } from "../src/index.js";

/** ADR-0029 D7: MCP Apps registered through the official ext-apps helpers. */

const ORIGIN = "https://example.test";
const APP_URI = "ui://mantle/views";
const HTML = "<!doctype html><title>Mantle</title>";

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
metadata: { name: refresh-post }
spec:
  mcp: { readOnlyHint: true }
  input: { type: object, properties: { id: { type: string } } }
  output: { type: object }
  handler: { kind: ref, ref: refresh }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: refresh-post-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: refresh-post }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: like-post }
spec:
  input: { type: object, properties: { id: { type: string } } }
  output: { type: object }
  handler: { kind: ref, ref: like }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: like-post-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: like-post }
`;

const apps: MantleMcpApps = {
  resources: [{
    uri: APP_URI,
    name: "mantle-views",
    title: "Mantle Views",
    html: async () => HTML,
    csp: { connectDomains: [] },
    renders: (capability) => capability.route.kind === "view",
    appOnly: ["refresh_post"],
  }],
};

const UI_CAPABILITIES = { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } };

describe("MCP Apps registration", () => {
  it("links View tools to the UI resource and serves reusable HTML to a client with MCP Apps", async () => {
    const client = await connect("modern", UI_CAPABILITIES);
    const { tools } = await client.listTools();
    const view = tools.find((tool) => tool.name === "query_view_public_posts")!;
    expect(view._meta).toMatchObject({ ui: { resourceUri: APP_URI }, "ui/resourceUri": APP_URI });
    expect(tools.find((tool) => tool.name === "like_post")).not.toHaveProperty("_meta");
    expect(tools.find((tool) => tool.name === "refresh_post")?._meta).toMatchObject({ ui: { resourceUri: APP_URI, visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources).toEqual([expect.objectContaining({ uri: APP_URI, mimeType: RESOURCE_MIME_TYPE })]);
    const read = await client.readResource({ uri: APP_URI });
    expect(read.contents).toEqual([expect.objectContaining({ uri: APP_URI, mimeType: RESOURCE_MIME_TYPE, text: HTML })]);
    // Every App tool keeps its text content for hosts that render no UI.
    const result = await client.callTool({ name: "query_view_public_posts", arguments: {} });
    expect(result.content).toEqual([expect.objectContaining({ type: "text" })]);
  });

  it("serves plain tools, no resources and no app-only tools to a client without MCP Apps", async () => {
    const client = await connect("modern", {});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["like_post", "query_view_public_posts"]);
    expect(tools.every((tool) => tool._meta === undefined)).toBe(true);
    await expect(client.readResource({ uri: APP_URI })).rejects.toThrow();
    await expect(client.callTool({ name: "refresh_post", arguments: {} })).rejects.toThrow(/not found/iu);
  });

  it("keeps App metadata for a 2025 stateless request, whose client capabilities are unknown", async () => {
    // Hosts without MCP Apps ignore `_meta.ui`; hosts with it must be able to
    // list and call the App's tools on every stateless request.
    const client = await connect("legacy", {});
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "query_view_public_posts")?._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(tools.map((tool) => tool.name)).toContain("refresh_post");
  });

  it("reads the client's MCP Apps support from the envelope or initialize only", () => {
    const envelope = (capabilities: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {
      _meta: { "io.modelcontextprotocol/clientCapabilities": capabilities },
    } });
    expect(clientUiSupport(envelope(UI_CAPABILITIES))).toBe("supported");
    expect(clientUiSupport(envelope({}))).toBe("unsupported");
    expect(clientUiSupport({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: UI_CAPABILITIES } })).toBe("supported");
    expect(clientUiSupport({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe("unknown");
    // A client that lists the extension but not the MCP App MIME type cannot render it.
    expect(clientUiSupport(envelope({ extensions: { [EXTENSION_ID]: { mimeTypes: ["text/html"] } } }))).toBe("unsupported");
  });

  it("keeps each surface's resources on that surface", async () => {
    const plain = await connect("modern", UI_CAPABILITIES, {});
    await expect(plain.readResource({ uri: APP_URI })).rejects.toThrow();
  });

  it("treats a hidden app-only tool as unknown: audited, never an identity challenge", async () => {
    const events: McpToolCallAuditEvent[] = [];
    const plan = compile(manifest);
    const handler = createMantleMcpHandler(bindCapabilities(runtime(plan), plan, { surface: "public" }), {
      apps,
      audit: { record: (event) => { events.push(event); } },
      unauthenticated: () => new Response(null, { status: 401 }),
    });
    const call = await handler.fetch(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "refresh_post",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "plain", version: "1" },
        },
      } }),
    }), anonymous());
    expect(call.status).not.toBe(401);
    await Promise.resolve();
    expect(events).toEqual([expect.objectContaining({ tool: "refresh_post", outcome: "UNKNOWN_TOOL" })]);
  });

  it("lets an App call its app-only tool on a stateless 2025 request", async () => {
    const client = await connect("legacy", UI_CAPABILITIES);
    const result = await client.callTool({ name: "refresh_post", arguments: { id: "p1" } });
    expect(result.isError).toBeFalsy();
  });

  it("omits empty resource metadata", async () => {
    const bare: MantleMcpApps = { resources: [{ uri: APP_URI, name: "bare", html: HTML, renders: () => false }] };
    const client = await connect("modern", UI_CAPABILITIES, { apps: bare });
    const { resources } = await client.listResources();
    expect(resources[0]).not.toHaveProperty("_meta");
  });

  it("carries no UI dependency: the HTML is injected by the host", async () => {
    const { default: pkg } = await import("../package.json", { with: { type: "json" } });
    const runtimeDeps = Object.keys({ ...pkg.dependencies, ...(pkg as { peerDependencies?: object }).peerDependencies });
    expect(runtimeDeps.filter((name) => /react|vite|mantle-ui|admin-ui/u.test(name))).toEqual([]);
  });

  it("refuses an app-only tool that writes and a resource outside ui://", () => {
    const invoker = bindCapabilities(runtime(compile(manifest)), compile(manifest), { surface: "public" });
    const resource = apps.resources[0]!;
    expect(() => createMantleMcpHandler(invoker, { apps: { resources: [{ ...resource, appOnly: ["like_post"] }] } }))
      .toThrow(/must be declared read-only/u);
    // One tool links to one resource, whether it renders there or is app-only there.
    const other = { ...resource, uri: "ui://mantle/other", name: "other", renders: () => false, appOnly: ["query_view_public_posts"] };
    expect(() => createMantleMcpHandler(invoker, { apps: { resources: [{ ...resource, appOnly: [] }, other] } }))
      .toThrow(/links to both/u);
    expect(() => createMantleMcpHandler(invoker, { apps: { resources: [{ ...resource, uri: "https://x.test/app" }] } }))
      .toThrow(/ui:\/\//u);
    expect(() => createMantleMcpHandler(invoker, { apps: { resources: [{ ...resource, appOnly: ["ghost"] }] } }))
      .toThrow(/not served/u);
  });
});

async function connect(era: "modern" | "legacy", capabilities: Record<string, unknown>, options: { apps?: MantleMcpApps } = { apps }) {
  const plan = compile(manifest);
  const handler = createMantleMcpHandler(bindCapabilities(runtime(plan), plan, { surface: "public" }), options);
  const client = new Client(
    { name: "mantle-apps-test", version: "1.0.0" },
    { capabilities, ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}) },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: async (input: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(input, init), anonymous()),
  }));
  return client;
}

function runtime(plan: RuntimePlan): CapabilityRuntime {
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
    executeView: async () => ({ ok: true, result: { rows: [], page: 1, show: 20, hasMore: false } }),
    invokeTrigger: async () => ({ ok: true, data: {} }),
    media: null,
  } as unknown as CapabilityRuntime;
}

function compile(text: string): RuntimePlan {
  const parsed = parseManifestSources({ sources: [{ sourceId: "memory:apps", text }] });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join("\n"));
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error(linked.diagnostics.map((item) => item.message).join("\n"));
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled plan");
  return compiled.value;
}

function anonymous(): HandlerContext {
  return { user: null, staff: null, env: {} };
}
