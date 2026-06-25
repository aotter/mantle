import {
  DiagnosticError,
  redactForWire,
  type ContentState,
  type MediaPurposePolicy,
  type ProcedureManifest,
  type SchemaManifest,
  type StaffRole,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { MediaVariantRole } from "../../domain/port/MediaStorage.js";
import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  ListEntriesUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "../../usecase/content/index.js";
import {
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
} from "../../usecase/media/index.js";
import { mcpToolNameSegment } from "../../domain/service/McpToolNaming.js";
import { ExecuteViewUseCase } from "../../usecase/view/index.js";
import { InvokeProcedureUseCase } from "../../usecase/procedure/InvokeProcedureUseCase.js";
import {
  CREATE_DRAFT_PREFIX,
  QUERY_VIEW_PREFIX,
  UPDATE_DRAFT_PREFIX,
  buildMcpToolCatalog,
  extractCollectionSegment,
  type McpToolSurface,
  type McpToolDefinition,
} from "./McpToolCatalog.js";
import {
  jsonRpcError,
  jsonRpcOk,
  jsonRpcOkRaw,
} from "./McpResponses.js";

/** JSON-RPC dispatcher for the MCP transport. Env-agnostic; the
 *  adapter resolves the caller's identity and hands `dispatch` a
 *  `McpAuthContext` plus the use-case bag. */
export interface McpAuthContext {
  readonly userId: string;
  /** Caller's staff role; null for non-staff bearers. */
  readonly staff: { readonly userId: string; readonly role: StaffRole } | null;
}

/**
 * The use-case bag the dispatcher needs. Adapter constructs this once
 * per isolate from the runtime's pre-built use cases (the runtime's
 * assembly root assembles these alongside everything else).
 */
export interface McpUseCases {
  readonly listEntries: ListEntriesUseCase;
  readonly getEntry: GetEntryUseCase;
  readonly createDraft: CreateDraftUseCase;
  readonly updateDraft: UpdateDraftUseCase;
  readonly requestPublish: RequestPublishUseCase;
  readonly unpublish: UnpublishUseCase;
  readonly archive: ArchiveUseCase;
  readonly deleteEntry: DeleteEntryUseCase;
  readonly executeView?: ExecuteViewUseCase;
  /** Optional. When set together with `options.procedures`, MCP
   *  Triggers (#281) route through here. The dispatcher evaluates the
   *  Procedure's `requires.auth` against the McpAuthContext before
   *  invoking. */
  readonly invokeProcedure?: InvokeProcedureUseCase;
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
  /** segment → original `Schema.metadata.name`. Built once at
   *  construction; the per-collection routing path looks up the
   *  segment from the tool name and recovers the canonical
   *  collection name. */
  private readonly schemaBySegment: ReadonlyMap<string, string>;
  private readonly viewBySegment: ReadonlyMap<string, ViewManifest>;
  /** tool-name → Procedure manifest, for MCP triggers (#281). */
  private readonly procedureByToolName: ReadonlyMap<string, ProcedureManifest>;

  constructor(
    private readonly useCases: McpUseCases,
    private readonly schemas: ReadonlyArray<SchemaManifest>,
    private readonly options: {
      readonly surface?: McpToolSurface;
      readonly views?: ReadonlyArray<ViewManifest>;
      /** Procedures exposed on this MCP surface via
       *  `Trigger.source.kind: "mcp"` (#281). Adapter pre-filters
       *  by surface; dispatcher trusts the slice. */
      readonly procedures?: ReadonlyArray<ProcedureManifest>;
    } = {},
  ) {
    this.catalog = buildMcpToolCatalog(schemas, {
      surface: options.surface ?? "staff",
      mediaEnabled: useCases.media !== undefined,
      mediaPurposes: useCases.media?.purposes,
      views: options.views,
      procedures: options.procedures,
    });
    this.catalogWireJson = `{"tools":${JSON.stringify(this.catalog)}}`;
    const map = new Map<string, string>();
    for (const s of schemas) map.set(mcpToolNameSegment(s.metadata.name), s.metadata.name);
    this.schemaBySegment = map;
    const views = new Map<string, ViewManifest>();
    for (const v of options.views ?? []) views.set(mcpToolNameSegment(v.metadata.name), v);
    this.viewBySegment = views;
    const procs = new Map<string, ProcedureManifest>();
    for (const p of options.procedures ?? []) {
      procs.set(mcpToolNameSegment(p.metadata.name), p);
    }
    this.procedureByToolName = procs;
  }

  async dispatch(req: Request, auth: McpAuthContext): Promise<Response> {
    if (req.method === "GET") {
      return new Response("MCP endpoint — POST JSON-RPC here.", { status: 200 });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    let body: { id?: number | string | null; method?: string; params?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonRpcError(null, -32700, "parse error");
    }
    const { id = null, method, params } = body;

    switch (method) {
      case "initialize":
        return jsonRpcOk(id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "@aotter/mantle-runtime/mcp", version: "0.0.7-alpha" },
        });
      case "tools/list":
        return jsonRpcOkRaw(id, this.catalogWireJson);
      case "tools/call":
        return this.handleToolCall(id, params, auth);
      default:
        return jsonRpcError(id, -32601, `unknown method: ${method}`);
    }
  }

  private async handleToolCall(
    reqId: unknown,
    params: unknown,
    auth: McpAuthContext,
  ): Promise<Response> {
    const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!p || typeof p.name !== "string") {
      return jsonRpcError(reqId, -32602, "missing tool name");
    }
    const args = (p.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await this.dispatchToolByName(p.name, args, auth);
      if (result === UNKNOWN_TOOL) {
        return jsonRpcError(reqId, -32601, `unknown tool: ${p.name}`);
      }
      if (result === MISSING_ARG) {
        return jsonRpcError(reqId, -32602, "missing required arg");
      }
      return jsonRpcOk(reqId, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (e) {
      if (e instanceof DiagnosticError) {
        return jsonRpcError(reqId, -32000, e.diagnostic.message, redactForWire(e.diagnostic));
      }
      // Don't leak raw exception strings to MCP clients — adapter
      // exceptions can carry binding / driver detail. Real cause goes
      // to server-side logs; the wire stays opaque.
      console.error("[McpJsonRpcDispatcher] unhandled tool-call error", e);
      return jsonRpcError(reqId, -32000, "Internal error.");
    }
  }

  private async dispatchToolByName(
    name: string,
    args: Record<string, unknown>,
    auth: McpAuthContext,
  ): Promise<unknown | typeof UNKNOWN_TOOL | typeof MISSING_ARG> {
    // Procedure-derived MCP tools (#281). Check first on every
    // surface — a Procedure's tool name lives in the same namespace
    // as the per-collection / per-view tools, and the catalog
    // collision check runs at boot so we don't have to disambiguate
    // here.
    const procedure = this.procedureByToolName.get(name);
    if (procedure) {
      if (!this.useCases.invokeProcedure) return UNKNOWN_TOOL;
      const procCtx = {
        user: { id: auth.userId },
        staff: auth.staff
          ? { id: auth.staff.userId, role: auth.staff.role }
          : null,
        env: {},
      };
      return this.useCases.invokeProcedure.execute({
        procedure,
        input: args,
        ctx: procCtx,
        pathPrefix: `MCP ${name}`,
      });
    }

    if ((this.options.surface ?? "staff") === "public") {
      const viewSegment = extractCollectionSegment(name, QUERY_VIEW_PREFIX);
      if (!viewSegment) return UNKNOWN_TOOL;
      const view = this.viewBySegment.get(viewSegment);
      if (!view || !this.useCases.executeView) return UNKNOWN_TOOL;
      // Build ctx from the bearer-derived McpAuthContext so the
      // executeView use case can evaluate `requires.auth.all`. Without
      // this, every auth-gated public-surface View returned
      // UNAUTHENTICATED for every caller including authenticated staff.
      const result = await this.useCases.executeView.execute({
        view,
        options: {
          params: stripViewReservedArgs(args),
          page: typeof args["page"] === "number" ? args["page"] : undefined,
          show: typeof args["show"] === "number" ? args["show"] : undefined,
        },
        pathPrefix: `MCP ${name}`,
        ctx: {
          user: { id: auth.userId },
          staff: auth.staff
            ? { id: auth.staff.userId, role: auth.staff.role }
            : null,
          env: {},
        },
      });
      return result;
    }

    switch (name) {
      case "list_entries": {
        const collection = args["collection"];
        if (typeof collection !== "string") return MISSING_ARG;
        // MCP exposes the cursored shape so agents can walk pages
        // through `nextCursor`. App code reaches for `execute()`
        // instead and gets a flat array.
        return this.useCases.listEntries.executePage({
          collection,
          status: args["status"] as ContentState | undefined,
          limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
          cursor: typeof args["cursor"] === "string" ? args["cursor"] : undefined,
        });
      }
      case "get_entry": {
        const id = args["id"];
        if (typeof id !== "string") return MISSING_ARG;
        return this.useCases.getEntry.execute({ id });
      }
      case "request_publish": {
        const id = args["id"];
        if (typeof id !== "string") return MISSING_ARG;
        return this.useCases.requestPublish.execute({ id });
      }
      case "unpublish_entry": {
        const id = args["id"];
        if (typeof id !== "string") return MISSING_ARG;
        return this.useCases.unpublish.execute({ id });
      }
      case "archive_entry": {
        const id = args["id"];
        const expected = args["expected_version"];
        if (typeof id !== "string" || typeof expected !== "number") return MISSING_ARG;
        return this.useCases.archive.execute({ id, expectedVersion: expected });
      }
      case "delete_entry": {
        const id = args["id"];
        if (typeof id !== "string") return MISSING_ARG;
        return this.useCases.deleteEntry.execute({ id });
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
        // Per-collection authoring tools: `create_draft_<segment>` /
        // `update_draft_<segment>`. The agent sends Schema fields at
        // the top level; we rebuild `data` for the chokepoint.
        // `hookCtx` plumbs the authenticated MCP user into lifecycle
        // hook context so consumers can branch on `ctx.user` (e.g.
        // bypass captcha checks for authenticated agents).
        const hookCtx = {
          user: { id: auth.userId },
          staff: auth.staff ? { id: auth.staff.userId, role: auth.staff.role } : null,
          env: {},
        };
        const createSegment = extractCollectionSegment(name, CREATE_DRAFT_PREFIX);
        if (createSegment) {
          const collection = this.schemaBySegment.get(createSegment);
          if (!collection) return UNKNOWN_TOOL;
          return this.useCases.createDraft.execute({
            collection,
            data: stripReservedArgs(args),
            authorId: auth.userId,
            ctx: hookCtx,
          });
        }
        const updateSegment = extractCollectionSegment(name, UPDATE_DRAFT_PREFIX);
        if (updateSegment) {
          const collection = this.schemaBySegment.get(updateSegment);
          if (!collection) return UNKNOWN_TOOL;
          const id = args["id"];
          const expected = args["expected_version"];
          if (typeof id !== "string" || typeof expected !== "number") return MISSING_ARG;
          // Caller may also call get_entry separately; we don't need
          // the collection on the chokepoint args because UpdateDraft
          // looks it up from the existing row.
          return this.useCases.updateDraft.execute({
            id,
            expectedVersion: expected,
            data: stripReservedArgs(args),
            ctx: hookCtx,
          });
        }
        return UNKNOWN_TOOL;
      }
    }
  }
}

const UNKNOWN_TOOL = Symbol("unknown-tool");
const MISSING_ARG = Symbol("missing-arg");

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

