import {
  DiagnosticError,
  HTTP_STATUS_BY_CODE,
  meetsRole,
  mcpToolNameSegment,
  redactForWire,
  runtimeDiagnostic,
  resolveLifecycle,
  type Diagnostic,
  type MediaPurposePolicy,
  type SchemaManifest,
  type SiteIcon,
  type StaffRole,
} from "@aotter/mantle-spec";
import type { MediaVariantRole } from "../../domain/port/MediaStorage.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import type { AuditSink } from "../../domain/port/AuditSink.js";
import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../../usecase/content/index.js";
import {
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
} from "../../usecase/media/index.js";
import { ExecuteViewUseCase } from "../../usecase/view/index.js";
import type { RuntimeCallableCapability } from "../../domain/service/CallableCapabilityProjector.js";
import {
  CREATE_DRAFT_PREFIX,
  CONTENT_LIFECYCLE_TOOLS,
  CREATE_RECORD_PREFIX,
  UPDATE_DRAFT_PREFIX,
  UPDATE_RECORD_PREFIX,
  buildMcpToolCatalog,
  extractCollectionSegment,
  type McpToolSurface,
  type McpToolDefinition,
  idempotencyKeys,
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
 * The use-case bag the dispatcher needs. Adapter constructs this once
 * per isolate from the runtime's pre-built use cases (the runtime's
 * assembly root assembles these alongside everything else).
 */
export interface McpUseCases {
  readonly getEntry: GetEntryUseCase;
  readonly createDraft: CreateDraftUseCase;
  readonly updateDraft: UpdateDraftUseCase;
  readonly requestPublish: RequestPublishUseCase;
  readonly unpublish: UnpublishUseCase;
  readonly archive: ArchiveUseCase;
  readonly deleteEntry: DeleteEntryUseCase;
  readonly executeView?: Pick<ExecuteViewUseCase, "execute">;
  /** Optional. Trigger-backed callable capabilities route through the
   *  runtime's shared Trigger invocation chokepoint. */
  readonly invokeTrigger?: {
    execute(request: {
      readonly trigger: string;
      readonly input: unknown;
      readonly ctx: HandlerContext;
      readonly pathPrefix?: string;
    }): Promise<
      | { readonly ok: true; readonly data: unknown }
      | { readonly ok: false; readonly diagnostic: Diagnostic }
    >;
  };
  /** Optional. When set, `create_media_upload` and
   *  `commit_media_upload` appear in the catalog and route here.
   *  `purposes` is the declared taxonomy (#272 shape — name +
   *  required mimes + maxBytes per mime); the catalog inlines the
   *  policy summary into the create tool's description. */
  readonly media?: {
    readonly createUpload: CreateMediaUploadUseCase;
    readonly commitUpload: CommitMediaUploadUseCase;
    readonly purposes: readonly MediaPurposePolicy[];
  };
}

export class McpJsonRpcDispatcher {
  private readonly catalog: readonly McpToolDefinition[];
  private readonly catalogWireJson: string;
  private readonly catalogToolNames: ReadonlySet<string>;
  /** segment → original `Schema.metadata.name`. Built once at
   *  construction; the per-collection routing path looks up the
   *  segment from the tool name and recovers the canonical
   *  collection name. */
  private readonly schemaBySegment: ReadonlyMap<string, string>;
  private readonly readOnlyCollections: ReadonlySet<string>;
  private readonly capabilityByToolName: ReadonlyMap<string, RuntimeCallableCapability>;
  /** tool → the input property that carries its idempotency key, for audit
   *  correlation. Tools without a declared key fall back to `operationId`. */
  private readonly operationKeyByTool: ReadonlyMap<string, string>;

  constructor(
    private readonly useCases: McpUseCases,
    private readonly schemas: ReadonlyArray<SchemaManifest>,
    private readonly options: {
      readonly surface?: McpToolSurface;
      readonly capabilities?: readonly RuntimeCallableCapability[];
      readonly serverInfo?: McpServerInfo;
      /** Optional tools/call audit trail. See `AuditSink`. */
      readonly audit?: AuditSink;
    } = {},
  ) {
    this.catalog = buildMcpToolCatalog(schemas, {
      surface: options.surface ?? "staff",
      mediaEnabled: useCases.media !== undefined,
      mediaPurposes: useCases.media?.purposes,
      capabilities: options.capabilities,
    });
    this.catalogWireJson = `{"tools":${JSON.stringify(this.catalog)}}`;
    this.operationKeyByTool = new Map(
      this.catalog.map((tool) => [tool.name, idempotencyKeys(tool.inputSchema)[0] ?? "operationId"]),
    );
    this.catalogToolNames = new Set(this.catalog.map((tool) => tool.name));
    this.readOnlyCollections = new Set(
      schemas.filter((schema) => schema.spec.schema.readOnly === true).map((schema) => schema.metadata.name),
    );
    const map = new Map<string, string>();
    for (const s of schemas) map.set(mcpToolNameSegment(s.metadata.name), s.metadata.name);
    this.schemaBySegment = map;
    this.capabilityByToolName = new Map(
      (options.capabilities ?? [])
        .filter((item) => item.surface === (options.surface ?? "staff"))
        .map((item) => [item.name, item]),
    );
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
    const operationKey = this.operationKeyByTool.get(p.name) ?? "operationId";
    const operationValue = args[operationKey];
    const operationId = typeof operationValue === "string" ? operationValue : null;
    let outcome = "ok";
    try {
      if (!this.catalogToolNames.has(p.name)) {
        outcome = "UNKNOWN_TOOL";
        return jsonRpcError(reqId, -32601, `unknown tool: ${p.name}`);
      }
      const result = await this.dispatchToolByName(p.name, args, ctx);
      if (result === UNKNOWN_TOOL) {
        outcome = "UNKNOWN_TOOL";
        return jsonRpcError(reqId, -32601, `unknown tool: ${p.name}`);
      }
      if (result === MISSING_ARG) {
        outcome = "INVALID_PARAMS";
        return jsonRpcError(reqId, -32602, "missing required arg");
      }
      return jsonRpcOk(reqId, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (e) {
      if (e instanceof DiagnosticError) {
        outcome = e.diagnostic.code;
        // Identity failures are HTTP facts too: an anonymous caller on a tool
        // that requires one must see 401 so it can authenticate and retry,
        // and the adapter can attach its OAuth challenge (#977).
        const status = e.diagnostic.code === "UNAUTHENTICATED" || e.diagnostic.code === "AUTH_DENIED"
          ? HTTP_STATUS_BY_CODE[e.diagnostic.code]
          : undefined;
        return jsonRpcError(reqId, -32000, e.diagnostic.message, redactForWire(e.diagnostic), status);
      }
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

  private async dispatchToolByName(
    name: string,
    args: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<unknown | typeof UNKNOWN_TOOL | typeof MISSING_ARG> {
    const capability = this.capabilityByToolName.get(name);
    if (capability?.kind === "procedure") {
      if (!this.useCases.invokeTrigger) return UNKNOWN_TOOL;
      const result = await this.useCases.invokeTrigger.execute({
        trigger: capability.trigger,
        input: args,
        ctx,
        pathPrefix: `MCP ${name}`,
      });
      if (!result.ok) throw new DiagnosticError(result.diagnostic);
      return result.data;
    }
    if (capability?.kind === "view") {
      if (!this.useCases.executeView) return UNKNOWN_TOOL;
      // Use the adapter-normalized caller so the executeView use case can
      // evaluate `requires.auth.all`. Without
      // this, every auth-gated public-surface View returned
      // UNAUTHENTICATED for every caller including authenticated staff.
      const result = await this.useCases.executeView.execute({
        view: capability.manifest,
        options: {
          params: stripViewReservedArgs(args),
          page: typeof args["page"] === "number" ? args["page"] : undefined,
          show: typeof args["show"] === "number" ? args["show"] : undefined,
        },
        pathPrefix: `MCP ${name}`,
        ctx,
      });
      if (!result.ok) throw new DiagnosticError(result.diagnostic);
      return result.result;
    }

    if ((this.options.surface ?? "staff") === "public") {
      return UNKNOWN_TOOL;
    }

    const minimumRole = genericStaffToolMinimumRole(name);
    if (minimumRole) this.assertStaffRole(name, ctx, minimumRole);

    switch (name) {
      case "request_publish": {
        const id = args["id"];
        const collection = args["collection"];
        if (typeof id !== "string" || typeof collection !== "string") return MISSING_ARG;
        await this.assertEntryMutable(id, name, collection);
        return this.useCases.requestPublish.execute({
          id, collection,
          ctx,
          originalInput: { id },
        });
      }
      case "unpublish_entry": {
        const id = args["id"];
        const collection = args["collection"];
        if (typeof id !== "string" || typeof collection !== "string") return MISSING_ARG;
        await this.assertEntryMutable(id, name, collection);
        return this.useCases.unpublish.execute({
          id, collection,
          ctx,
          originalInput: { id },
        });
      }
      case "archive_entry": {
        const id = args["id"];
        const collection = args["collection"];
        if (typeof id !== "string" || typeof collection !== "string") return MISSING_ARG;
        await this.assertEntryMutable(id, name, collection);
        return this.useCases.archive.execute({
          id, collection,
          ctx,
          originalInput: { id },
        });
      }
      case "delete_entry": {
        const id = args["id"];
        const collection = args["collection"];
        if (typeof id !== "string" || typeof collection !== "string") return MISSING_ARG;
        await this.assertEntryMutable(id, name, collection);
        return this.useCases.deleteEntry.execute({
          id, collection,
          ctx,
          originalInput: { id },
        });
      }
      case "create_media_upload": {
        if (!this.useCases.media) return UNKNOWN_TOOL;
        const filename = args["filename"];
        const purpose = args["purpose"];
        const rawVariants = args["variants"];
        if (
          typeof filename !== "string" ||
          typeof purpose !== "string" ||
          !Array.isArray(rawVariants)
        ) {
          return MISSING_ARG;
        }
        const variants: Array<{
          mimeType: string;
          byteSize: number;
          role: MediaVariantRole;
        }> = [];
        for (const raw of rawVariants) {
          if (raw === null || typeof raw !== "object") return MISSING_ARG;
          const v = raw as Record<string, unknown>;
          const mimeType = v["mimeType"];
          const byteSize = v["byteSize"];
          const role = v["role"];
          if (
            typeof mimeType !== "string" ||
            typeof byteSize !== "number" ||
            !Number.isSafeInteger(byteSize) ||
            byteSize <= 0 ||
            (role !== "primary" && role !== "alternate" && role !== "fallback")
          ) {
            return MISSING_ARG;
          }
          variants.push({ mimeType, byteSize, role });
        }
        return this.useCases.media.createUpload.execute({
          filename,
          purpose,
          variants,
          alt: typeof args["alt"] === "string" ? args["alt"] : undefined,
          caption: typeof args["caption"] === "string" ? args["caption"] : undefined,
        });
      }
      case "commit_media_upload": {
        if (!this.useCases.media) return UNKNOWN_TOOL;
        const uploadGroupId = args["uploadGroupId"];
        if (typeof uploadGroupId !== "string") return MISSING_ARG;
        return this.useCases.media.commitUpload.execute({
          uploadGroupId,
          alt: typeof args["alt"] === "string" ? args["alt"] : undefined,
          caption: typeof args["caption"] === "string" ? args["caption"] : undefined,
        });
      }
      default: {
        // Per-collection content-draft or operational-record tools.
        // The agent sends Schema fields at the top level; we rebuild
        // `data` for the chokepoint.
        const createSegment =
          extractCollectionSegment(name, CREATE_DRAFT_PREFIX) ??
          extractCollectionSegment(name, CREATE_RECORD_PREFIX);
        if (createSegment) {
          const collection = this.schemaBySegment.get(createSegment);
          if (!collection) return UNKNOWN_TOOL;
          const data = stripReservedArgs(args);
          return this.useCases.createDraft.execute({
            collection,
            data,
            authorId: ctx.user?.id ?? null,
            ctx,
            originalInput: data,
          });
        }
        const updateSegment =
          extractCollectionSegment(name, UPDATE_DRAFT_PREFIX) ??
          extractCollectionSegment(name, UPDATE_RECORD_PREFIX);
        if (updateSegment) {
          const collection = this.schemaBySegment.get(updateSegment);
          if (!collection) return UNKNOWN_TOOL;
          const id = args["id"];
          const expected = args["expected_version"];
          if (typeof id !== "string" || typeof expected !== "number") return MISSING_ARG;
          await this.assertEntryMutable(id, name, collection);
          const data = stripReservedArgs(args);
          return this.useCases.updateDraft.execute({
            id,
            collection,
            expectedVersion: expected,
            data,
            ctx,
            originalInput: data,
          });
        }
        return UNKNOWN_TOOL;
      }
    }
  }

  private assertStaffRole(toolName: string, ctx: HandlerContext, minimumRole: StaffRole): void {
    const role = ctx.staff?.role;
    if (role && meetsRole(role, minimumRole)) return;
    throw new DiagnosticError(runtimeDiagnostic({
      code: "AUTH_DENIED",
      severity: "error",
      path: `MCP ${toolName}`,
      expected: `${minimumRole} role or higher for the signed-in staff user`,
      message: `Tool '${toolName}' requires the ${minimumRole} role.`,
    }));
  }

  private async assertEntryMutable(id: string, toolName: string, collection: string): Promise<void> {
    const entry = await this.useCases.getEntry.execute({ id, collection });
    const schema = this.schemas.find((s) => s.metadata.name === entry.collection);
    if (CONTENT_LIFECYCLE_TOOLS.has(toolName) && (!schema || resolveLifecycle(schema) === "operational")) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "CONFLICT", severity: "error", path: `MCP ${toolName}`,
        value: entry.collection, expected: "a content lifecycle",
        message: `Tool '${toolName}' requires a content lifecycle; '${entry.collection}' does not support publishing transitions. Use its declared Procedures.`,
      }));
    }
    if (!this.readOnlyCollections.has(entry.collection)) return;
    throw new DiagnosticError(runtimeDiagnostic({
      code: "CONFLICT",
      severity: "error",
      path: `MCP ${toolName}`,
      value: entry.collection,
      expected: "a Schema without root readOnly: true",
      message: `Schema '${entry.collection}' is read-only on generic authoring surfaces; use its declared Procedures.`,
    }));
  }
}

const UNKNOWN_TOOL = Symbol("unknown-tool");
const MISSING_ARG = Symbol("missing-arg");
const EDITOR_GENERIC_TOOLS: ReadonlySet<string> = new Set([
  "request_publish",
  "unpublish_entry",
  "archive_entry",
  "delete_entry",
  "create_media_upload",
  "commit_media_upload",
]);

function genericStaffToolMinimumRole(name: string): StaffRole | null {
  if (EDITOR_GENERIC_TOOLS.has(name)) return "editor";
  if (
    extractCollectionSegment(name, CREATE_RECORD_PREFIX) ||
    extractCollectionSegment(name, UPDATE_RECORD_PREFIX)
  ) {
    return "editor";
  }
  if (
    extractCollectionSegment(name, CREATE_DRAFT_PREFIX) ||
    extractCollectionSegment(name, UPDATE_DRAFT_PREFIX)
  ) {
    return "contributor";
  }
  return null;
}

/**
 * Strip the `id` + `expected_version` envelope keys before passing
 * the rest to the chokepoint as `data`. Per-collection update tools
 * mix routing keys (id, expected_version) with authoring fields at
 * the same level; this re-separates them.
 */
const RESERVED_ARG_KEYS: readonly string[] = ["id", "expected_version"];
function stripReservedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (RESERVED_ARG_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

const VIEW_RESERVED_ARG_KEYS: readonly string[] = ["page", "show"];
function stripViewReservedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (VIEW_RESERVED_ARG_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
