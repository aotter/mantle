import type { MediaPurposePolicy } from "@aotter/mantle-spec";
import type { MantleMedia, MantleRuntime } from "../../MantleRuntime.js";
import type { AuditSink } from "../../domain/port/AuditSink.js";
import { projectCallableCapabilities } from "../../domain/service/CallableCapabilityProjector.js";
import type { RuntimePlan } from "../../domain/service/RuntimePlanCompiler.js";
import { McpJsonRpcDispatcher, type McpServerInfo } from "./McpJsonRpcDispatcher.js";
import type { McpToolSurface } from "./McpToolCatalog.js";

/** The runtime members an MCP surface dispatches to. */
export type McpDispatcherRuntime = Pick<
  MantleRuntime,
  | "schemas"
  | "getEntry"
  | "createDraft"
  | "updateDraft"
  | "requestPublish"
  | "unpublish"
  | "archive"
  | "deleteEntry"
  | "executeView"
  | "invokeTrigger"
> & {
  readonly media: Pick<MantleMedia, "createUpload" | "commitUpload"> | null;
};

export interface CreateMcpDispatcherOptions {
  readonly surface: McpToolSurface;
  /** Declared `media.purposes`. Media tools are served only when the runtime
   *  has media storage and at least one purpose is declared. */
  readonly mediaPurposes?: readonly MediaPurposePolicy[];
  readonly serverInfo?: McpServerInfo;
  readonly audit?: AuditSink;
}

/**
 * Bind one MCP surface of a prepared runtime. The caller still resolves the
 * caller identity and applies its surface gate before `dispatch`; this only
 * wires the runtime use cases and the sealed-plan capability projection.
 */
export function createMcpDispatcher(
  runtime: McpDispatcherRuntime,
  plan: RuntimePlan,
  options: CreateMcpDispatcherOptions,
): McpJsonRpcDispatcher {
  const { surface } = options;
  const purposes = options.mediaPurposes ?? [];
  const media = runtime.media && purposes.length > 0
    ? { createUpload: runtime.media.createUpload, commitUpload: runtime.media.commitUpload, purposes }
    : undefined;
  return new McpJsonRpcDispatcher(
    {
      getEntry: runtime.getEntry,
      createDraft: runtime.createDraft,
      updateDraft: runtime.updateDraft,
      requestPublish: runtime.requestPublish,
      unpublish: runtime.unpublish,
      archive: runtime.archive,
      deleteEntry: runtime.deleteEntry,
      executeView: {
        execute: (request) => runtime.executeView({ ...request, view: request.view.metadata.name }),
      },
      invokeTrigger: { execute: (request) => runtime.invokeTrigger(request) },
      media,
    },
    [...runtime.schemas.values()],
    {
      surface,
      capabilities: projectCallableCapabilities(plan, { surface }),
      ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
    },
  );
}
