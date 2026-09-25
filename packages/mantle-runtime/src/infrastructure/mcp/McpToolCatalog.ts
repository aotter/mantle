import type { MediaPurposePolicy, SchemaManifest } from "@aotter/mantle-spec";
import type { RuntimeCallableCapability } from "../../domain/service/CallableCapabilityProjector.js";
import {
  buildCapabilityCatalog,
  type Capability,
  type CapabilityHints,
  type CapabilitySurface,
} from "../../domain/service/CapabilityCatalog.js";

/**
 * MCP wire shape of one catalog capability. Semantics (names, schemas,
 * descriptions, role floors) come from `CapabilityCatalog`; this module only
 * renames fields for `tools/list`.
 */
export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Advertised only when every output Runtime accepts also satisfies it
   *  under a standard JSON Schema validator; see `projectStandardOutputSchema`. */
  readonly outputSchema?: Record<string, unknown>;
  /** MCP tool annotations (spec: absent hints default to the conservative
   *  `destructiveHint: true` / `openWorldHint: true`). Only provable or
   *  author-declared values are emitted (#972). */
  readonly annotations?: McpToolAnnotations;
}

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export type McpToolSurface = CapabilitySurface;

export function toMcpToolDefinition(capability: Capability): McpToolDefinition {
  const outputSchema = capability.outputSchema;
  return {
    name: capability.name,
    ...(capability.title ? { title: capability.title } : {}),
    description: capability.description,
    inputSchema: capability.inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(capability.hints ? { annotations: toMcpAnnotations(capability.hints) } : {}),
  };
}

/** Keeps the hint order, so the wire order stays stable. */
function toMcpAnnotations(hints: CapabilityHints): McpToolAnnotations {
  return Object.fromEntries(Object.entries(hints).map(([key, value]) => [`${key}Hint`, value]));
}

export interface BuildMcpToolCatalogOpts {
  /** When true, registers `create_media_upload` + `commit_media_upload`. */
  readonly mediaEnabled?: boolean;
  /** Declared `media.purposes`, inlined into `create_media_upload`. */
  readonly mediaPurposes?: readonly MediaPurposePolicy[];
  readonly surface?: McpToolSurface;
  /** Sealed-plan callable projection. */
  readonly capabilities?: readonly RuntimeCallableCapability[];
}

/** `tools/list` for one surface. Kept for the hand-written dispatcher and
 *  Admin WebMCP until both move to `@aotter/mantle-mcp` (#1131). */
export function buildMcpToolCatalog(
  schemas: ReadonlyArray<SchemaManifest>,
  opts: BuildMcpToolCatalogOpts = {},
): readonly McpToolDefinition[] {
  return buildCapabilityCatalog(schemas, {
    surface: opts.surface ?? "staff",
    callables: opts.capabilities,
    mediaPurposes: opts.mediaEnabled ? opts.mediaPurposes ?? [] : undefined,
  }).capabilities.map(toMcpToolDefinition);
}

/** Resolve each tool's declared correlation argument once at catalog build. */
export function buildMcpAuditOperationIdResolver(
  tools: readonly McpToolDefinition[],
): (tool: string, args: Readonly<Record<string, unknown>>) => string | null {
  const argumentsByTool = new Map(tools.map((tool) => [tool.name, idempotencyKey(tool.inputSchema)]));
  return (tool, args) => {
    const value = args[argumentsByTool.get(tool) ?? "operationId"];
    return typeof value === "string" ? value : null;
  };
}

function idempotencyKey(inputSchema: Record<string, unknown>): string {
  const properties = inputSchema["properties"];
  if (typeof properties !== "object" || properties === null) return "operationId";
  const match = Object.entries(properties as Record<string, unknown>).find(([, property]) =>
    typeof property === "object" && property !== null
    && (property as Record<string, unknown>)["x-mcp-hint"] === "idempotency-key");
  return match?.[0] ?? "operationId";
}
