import type { MediaPurposePolicy } from "@aotter/mantle-spec";
import { capabilityUseCases, type CapabilityRuntime } from "../../bindCapabilities.js";
import type { AuditSink } from "../../domain/port/AuditSink.js";
import { projectCallableCapabilities } from "../../domain/service/CallableCapabilityProjector.js";
import type { RuntimePlan } from "../../domain/service/RuntimePlanCompiler.js";
import { McpJsonRpcDispatcher, type McpServerInfo } from "./McpJsonRpcDispatcher.js";
import type { McpToolSurface } from "./McpToolCatalog.js";

/** The runtime members an MCP surface dispatches to. */
export type McpDispatcherRuntime = CapabilityRuntime;
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
  const { useCases, mediaPurposes } = capabilityUseCases(runtime, options.mediaPurposes);
  const media = useCases.media && mediaPurposes ? { ...useCases.media, purposes: mediaPurposes } : undefined;
  return new McpJsonRpcDispatcher(
    { ...useCases, media },
    [...runtime.schemas.values()],
    {
      surface,
      capabilities: projectCallableCapabilities(plan, { surface }),
      ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
    },
  );
}
