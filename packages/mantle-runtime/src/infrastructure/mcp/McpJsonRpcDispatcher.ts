import {
  HTTP_STATUS_BY_CODE,
  redactForWire,
  type MediaPurposePolicy,
  type SchemaManifest,
  type SiteIcon,
} from "@aotter/mantle-spec";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { AuditSink } from "../../domain/port/AuditSink.js";
import type { RuntimeCallableCapability } from "../../domain/service/CallableCapabilityProjector.js";
import { buildCapabilityCatalog } from "../../domain/service/CapabilityCatalog.js";
import {
  InvokeCapabilityUseCase,
  type CapabilityUseCases,
} from "../../usecase/capability/InvokeCapabilityUseCase.js";
import {
  buildMcpAuditOperationIdResolver,
  toMcpToolDefinition,
  type McpToolSurface,
} from "./McpToolCatalog.js";
import {
  jsonRpcError,
  jsonRpcOk,
  jsonRpcOkRaw,
} from "./McpResponses.js";
import packageJson from "../../../package.json" with { type: "json" };
import { JsonBodyTooLargeError, readJsonBody } from "../http/readJsonBody.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpServerInfo {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
  readonly icons?: readonly SiteIcon[];
}

/** JSON-RPC dispatcher for the MCP transport. Env-agnostic; the
 *  adapter resolves the caller's identity and hands `dispatch` the same
 *  normalized `HandlerContext` used by HTTP transports. */

/**
 * The use-case bag the dispatcher needs. `media.purposes` is the declared
 * taxonomy; media tools are served only when `media` is set.
 */
export interface McpUseCases extends Omit<CapabilityUseCases, "media"> {
  readonly media?: CapabilityUseCases["media"] & {
    readonly purposes: readonly MediaPurposePolicy[];
  };
}

export class McpJsonRpcDispatcher {
  private readonly invoker: InvokeCapabilityUseCase;
  private readonly catalogWireJson: string;
  private readonly auditOperationId: ReturnType<typeof buildMcpAuditOperationIdResolver>;

  constructor(
    useCases: McpUseCases,
    schemas: ReadonlyArray<SchemaManifest>,
    private readonly options: {
      readonly surface?: McpToolSurface;
      readonly capabilities?: readonly RuntimeCallableCapability[];
      readonly serverInfo?: McpServerInfo;
      /** Optional tools/call audit trail. See `AuditSink`. */
      readonly audit?: AuditSink;
    } = {},
  ) {
    const catalog = buildCapabilityCatalog(schemas, {
      surface: options.surface ?? "staff",
      callables: options.capabilities,
      mediaPurposes: useCases.media?.purposes,
    });
    this.invoker = new InvokeCapabilityUseCase(useCases, catalog, schemas);
    const tools = catalog.capabilities.map(toMcpToolDefinition);
    this.catalogWireJson = `{"tools":${JSON.stringify(tools)}}`;
    this.auditOperationId = buildMcpAuditOperationIdResolver(tools);
  }

  async dispatch(
    req: Request,
    ctx: HandlerContext,
  ): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    // JSON-RPC over HTTP is application/json. Refusing other types keeps a
    // cookie-session caller safe from HTML form POSTs, whose enctypes cannot
    // produce this header (#977).
    const contentType = req.headers.get("content-type") ?? "";
    if (!/^application\/json\b/iu.test(contentType.trim())) {
      return new Response("Content-Type must be application/json.", { status: 415 });
    }
    let body: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) {
        return new Response(error.message, { status: 413 });
      }
      return jsonRpcError(null, -32700, "parse error");
    }
    if (
      !body
      || typeof body !== "object"
      || Array.isArray(body)
      || body.jsonrpc !== "2.0"
      || typeof body.method !== "string"
    ) {
      return jsonRpcError(null, -32600, "invalid request");
    }
    const { id = null, method, params } = body;

    if (method !== "initialize" && req.headers.get("mcp-protocol-version") !== MCP_PROTOCOL_VERSION) {
      return new Response(`MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}.`, { status: 400 });
    }

    switch (method) {
      case "initialize":
        return jsonRpcOk(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            ...(this.options.serverInfo ?? { name: "aotter.mantle" }),
            version: packageJson.version,
          },
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return jsonRpcOkRaw(id, this.catalogWireJson);
      case "tools/call":
        return this.handleToolCall(id, params, ctx);
      default:
        return jsonRpcError(id, -32601, `unknown method: ${method}`);
    }
  }

  private async handleToolCall(
    reqId: unknown,
    params: unknown,
    ctx: HandlerContext,
  ): Promise<Response> {
    const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!p || typeof p.name !== "string") {
      return jsonRpcError(reqId, -32602, "missing tool name");
    }
    const args = (p.arguments ?? {}) as Record<string, unknown>;
    // Probing for tools that do not exist is audited like any other call.
    const startedAt = Date.now();
    const operationId = this.auditOperationId(p.name, args);
    let outcome = "ok";
    try {
      if (!this.invoker.catalog.get(p.name)) {
        outcome = "UNKNOWN_TOOL";
        return jsonRpcError(reqId, -32601, `unknown tool: ${p.name}`);
      }
      const result = await this.invoker.execute({ name: p.name, args, ctx, path: `MCP ${p.name}` });
      if (!result.ok) {
        outcome = result.diagnostic.code;
        // Identity failures are HTTP facts too: an anonymous caller on a tool
        // that requires one must see 401 so it can authenticate and retry,
        // and the adapter can attach its OAuth challenge (#977).
        const status = result.diagnostic.code === "UNAUTHENTICATED" || result.diagnostic.code === "AUTH_DENIED"
          ? HTTP_STATUS_BY_CODE[result.diagnostic.code]
          : undefined;
        return jsonRpcError(reqId, -32000, result.diagnostic.message, redactForWire(result.diagnostic), status);
      }
      return jsonRpcOk(reqId, {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        // Additive: the text block stays byte-identical for existing clients.
        // MCP requires structuredContent to be an object, so arrays and
        // primitives keep the text block only.
        ...(isPlainObject(result.data) ? { structuredContent: result.data } : {}),
      });
    } catch (e) {
      // Don't leak raw exception strings to MCP clients — adapter
      // exceptions can carry binding / driver detail. Real cause goes
      // to server-side logs; the wire stays opaque.
      outcome = "INTERNAL";
      console.error("[McpJsonRpcDispatcher] unhandled tool-call error", e);
      return jsonRpcError(reqId, -32000, "Internal error.");
    } finally {
      this.recordAudit(ctx, p.name, operationId, outcome, startedAt);
    }
  }

  /** The single audit write point. Off the response path: the sink's promise
   *  goes to the platform's `waitUntil` when present, and a failing sink is
   *  logged rather than turned into a tool error. */
  private recordAudit(
    ctx: HandlerContext,
    tool: string,
    operationId: string | null,
    outcome: string,
    startedAt: number,
  ): void {
    const audit = this.options.audit;
    if (!audit) return;
    const settled = Promise.resolve()
      .then(() => audit.record({
        at: startedAt,
        surface: this.options.surface ?? "staff",
        callerId: ctx.user?.id ?? null,
        clientId: ctx.auth?.clientId ?? null,
        credential: ctx.auth?.credential ?? null,
        tool,
        operationId,
        outcome,
        durationMs: Date.now() - startedAt,
      }))
      .catch((error: unknown) => {
        console.error("[McpJsonRpcDispatcher] audit sink failed", error);
      });
    ctx.waitUntil?.(settled);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
