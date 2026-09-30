/**
 * A View or Procedure name → MCP tool name: lowercase, kebab to snake. The one place the rule lives; the graph validator's
 * collision check and the MCP surface both use it.
 */
export function mcpToolNameSegment(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}
