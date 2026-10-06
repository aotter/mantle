import { resolveLocalizedText, type AuthorizationRequirements, type JsonSchema, type LocalizedText, type ProcedureMcpAnnotations } from "../model/ManifestGrammar.js";
import type { RuntimePlan } from "../model/RuntimePlan.js";

/**
 * A View or Procedure name → MCP tool name: lowercase, kebab to snake. The one place the rule lives; the graph validator's
 * collision check and the MCP surface both use it.
 */
export function mcpToolNameSegment(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}

/** One MCP tool and the Procedure or View it comes from. */
export interface McpTool {
  readonly name: string;
  readonly kind: "procedure" | "view";
  readonly source: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: ProcedureMcpAnnotations;
  readonly requires: AuthorizationRequirements | undefined;
}

/**
 * The tools an MCP surface lists (ADR-0032 decision 9): each Procedure bound by an `mcp` Trigger of the surface and each View of it,
 * never a Schema. `createMcpSurface` registers exactly these, and Admin's `/webmcp` publishes them, so the two cannot disagree.
 */
export function mcpTools(plan: RuntimePlan, surface: "public" | "staff", locale = "en"): McpTool[] {
  const text = (t: LocalizedText | undefined) => resolveLocalizedText(t, locale, "en") ?? undefined;
  const tools = new Map<string, McpTool>();
  const add = (tool: McpTool) => {
    const prior = tools.get(tool.name);
    if (prior && (prior.kind !== tool.kind || prior.source !== tool.source)) throw new TypeError(`MCP tool '${tool.name}' comes from both '${prior.source}' and '${tool.source}'.`);
    tools.set(tool.name, tool);
  };
  for (const t of Object.values(plan.triggers)) {
    if (t.source.kind !== "mcp" || t.source.surface !== surface) continue;
    const p = plan.procedures[t.procedure]!;
    const title = text(p.title);
    add({
      name: mcpToolNameSegment(t.procedure), kind: "procedure", source: t.procedure, ...(title ? { title } : {}),
      description: text(p.description) ?? title ?? t.procedure, inputSchema: p.input,
      // structuredContent must be an object
      ...(p.output.type === "object" ? { outputSchema: p.output } : {}),
      ...(p.mcp ? { annotations: p.mcp } : {}), requires: p.requires,
    });
  }
  for (const [name, v] of Object.entries(plan.views)) {
    if (v.surface !== surface) continue;
    const props = (v.input?.properties ?? {}) as Record<string, JsonSchema>;
    if ("limit" in props || "cursor" in props) throw new TypeError(`View '${name}' declares an input named limit or cursor; the MCP tool reserves both for paging.`);
    const title = text(v.title);
    add({
      name: mcpToolNameSegment(name), kind: "view", source: name, ...(title ? { title } : {}), description: text(v.description) ?? title ?? name,
      inputSchema: { type: "object", properties: { ...props, limit: { type: "integer", minimum: 1, maximum: 500 }, cursor: { type: "string" } }, ...(v.input?.required ? { required: v.input.required } : {}) } as JsonSchema,
      annotations: { readOnlyHint: true }, requires: v.requires,
    });
  }
  return [...tools.values()];
}
