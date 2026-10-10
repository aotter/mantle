export * from "./apps.js";
export * from "./createMcpSurface.js";
export * from "./catalog.js";
// Re-exported for bundles that may not import `@aotter/mantle/spec` (it bundles the SQL parser); pure naming code, no new dependency.
export { mcpTools, type McpTool } from "../spec/domain/index.js";
