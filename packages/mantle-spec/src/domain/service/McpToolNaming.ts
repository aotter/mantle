/**
 * `Schema.metadata.name` → MCP per-collection tool name suffix.
 * Lowercase + `kebab-` → `_snake`. Pure naming convention; the MCP
 * tool catalog factory and the boot collision check both reference
 * this so the rule lives in exactly one place.
 *
 * Lives in `domain/service/` (not `infrastructure/mcp/`) so the boot
 * use case can call it without violating the usecase→infrastructure
 * import rule.
 */
export function mcpToolNameSegment(collection: string): string {
  return collection.toLowerCase().replace(/-/g, "_");
}

/**
 * Built-in MCP tool names registered by the dispatcher regardless of
 * manifests. A Procedure exposed via `Trigger.source.kind: "mcp"`
 * (#281) MUST NOT mangle to any of these names — the dispatcher
 * routes by tool name and a collision would shadow the built-in.
 *
 * Mirror of the `name` fields in `McpToolCatalog.GENERIC_TOOLS` plus
 * the two media tool names. Lives here so the boot validator can
 * reference them without an infrastructure→usecase import.
 */
export const RESERVED_MCP_GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_entries",
  "get_entry",
  "request_publish",
  "unpublish_entry",
  "archive_entry",
  "delete_entry",
  "create_media_upload",
  "commit_media_upload",
]);

/**
 * Prefixes the catalog factory uses for Schema- / View-derived tools.
 * A Procedure tool name that starts with any of these would shadow
 * (or be shadowed by) a Schema's create/update tool or a View's
 * query tool, so boot rejects the manifest set with
 * `MCP_TOOL_NAME_COLLISION`.
 */
export const MCP_CREATE_DRAFT_PREFIX = "create_draft_";
export const MCP_UPDATE_DRAFT_PREFIX = "update_draft_";
export const MCP_CREATE_RECORD_PREFIX = "create_record_";
export const MCP_UPDATE_RECORD_PREFIX = "update_record_";
export const MCP_QUERY_VIEW_PREFIX = "query_view_";

export const RESERVED_MCP_TOOL_PREFIXES: readonly string[] = [
  MCP_CREATE_DRAFT_PREFIX,
  MCP_UPDATE_DRAFT_PREFIX,
  MCP_CREATE_RECORD_PREFIX,
  MCP_UPDATE_RECORD_PREFIX,
  MCP_QUERY_VIEW_PREFIX,
];
