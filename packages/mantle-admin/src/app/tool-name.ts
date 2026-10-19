/** The admin MCP tool of a View or Procedure: its name lowercased, kebab to snake (`mcpToolNameSegment` in @aotter/mantle's compiler). */
export const toolName = (name: string): string => name.toLowerCase().replace(/-/g, "_");
