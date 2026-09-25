/**
 * Test-only bridge that keeps the semantic assertions written for the retired
 * hand-written dispatcher, while every request now runs through the official
 * SDK via `createMantleMcpHandler`. It changes framing only: an `isError`
 * result is reshaped to the old `{ error: { code: -32000, data } }` view so
 * the assertions stay about which diagnostic Mantle produced. Wire-level
 * behaviour itself is asserted in `mantle-mcp.test.ts`.
 */
import type { MediaPurposePolicy, SchemaManifest } from "@aotter/mantle-spec";
import {
  buildCapabilityCatalog,
  InvokeCapabilityUseCase,
  type AuditSink,
  type CapabilityUseCases,
  type HandlerContext,
  type RuntimeCallableCapability,
} from "@aotter/mantle-runtime";
import { createMantleMcpHandler, mcpToolDefinitions, type MantleMcpServerInfo } from "../src/index.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpUseCases extends Omit<CapabilityUseCases, "media"> {
  readonly media?: CapabilityUseCases["media"] & { readonly purposes: readonly MediaPurposePolicy[] };
}

export class McpJsonRpcDispatcher {
  private readonly handler;

  constructor(
    useCases: McpUseCases,
    schemas: ReadonlyArray<SchemaManifest>,
    options: {
      readonly surface?: "staff" | "public";
      readonly capabilities?: readonly RuntimeCallableCapability[];
      readonly serverInfo?: MantleMcpServerInfo;
      readonly audit?: AuditSink;
    } = {},
  ) {
    const catalog = buildCapabilityCatalog(schemas, {
      surface: options.surface ?? "staff",
      callables: options.capabilities,
      mediaPurposes: useCases.media?.purposes,
    });
    this.handler = createMantleMcpHandler(new InvokeCapabilityUseCase(useCases, catalog, schemas), {
      ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
    });
  }

  async dispatch(request: Request, ctx: HandlerContext): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    const response = await this.handler.fetch(new Request(request, { headers }), ctx);
    if (!response.body || response.status === 202) return response;
    const text = await response.text();
    const data = /^(?:event|data):/mu.test(text)
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("")
      : text;
    let body: unknown;
    try { body = JSON.parse(data); } catch { return new Response(text, { status: response.status, headers: response.headers }); }
    return Response.json(legacyView(body), { status: response.status });
  }
}

/** Tool definitions for a catalog, as `tools/list` advertises them. */
export function buildMcpToolCatalog(
  schemas: ReadonlyArray<SchemaManifest>,
  opts: {
    readonly surface?: "staff" | "public";
    readonly capabilities?: readonly RuntimeCallableCapability[];
    readonly mediaEnabled?: boolean;
    readonly mediaPurposes?: readonly MediaPurposePolicy[];
  } = {},
) {
  const catalog = buildCapabilityCatalog(schemas, {
    surface: opts.surface ?? "staff",
    callables: opts.capabilities,
    mediaPurposes: opts.mediaEnabled ? opts.mediaPurposes ?? [] : undefined,
  });
  // Listing only: every route is bound, none is ever called.
  const unused = { execute: () => { throw new Error("not called"); } };
  const bound = { invokeTrigger: unused, executeView: unused, media: { createUpload: unused, commitUpload: unused } };
  return mcpToolDefinitions(new InvokeCapabilityUseCase(bound as unknown as CapabilityUseCases, catalog, schemas));
}

function legacyView(body: unknown): unknown {
  const result = (body as { result?: { isError?: boolean; content?: { type: string; text?: string }[] } }).result;
  if (!result?.isError) return body;
  const text = result.content?.find((item) => item.type === "text")?.text ?? "{}";
  const diagnostic = (JSON.parse(text) as { diagnostics?: { message?: string }[] }).diagnostics?.[0];
  return {
    jsonrpc: "2.0",
    id: (body as { id?: unknown }).id ?? null,
    error: { code: -32000, message: diagnostic?.message ?? "", data: diagnostic },
  };
}
