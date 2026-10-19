import { api, ApiError, refusalOf } from "./api";

export interface AdminTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean };
}
export interface AdminToolCatalog {
  tools: AdminTool[];
  routes: Record<string, { path: string; entry?: boolean }>;
}
export interface AdminModelContext {
  registerTool(tool: AdminTool & { execute(input: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<unknown> }, options: { signal: AbortSignal }): void | Promise<void>;
}
/** UI-only tools, defined and run by this page with no server call, so they carry no version: a page cannot list one
 *  definition and run another, and a reload after a deploy replaces both. */
export const navigationTools: AdminTool[] = [
  { name: "admin_get_context", title: "Admin get context", description: "Read the current Admin page and available admin tools. Call before navigating or changing data.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "admin_navigate", title: "Admin navigate", description: "Navigate to a same-origin Admin page. Use /admin/c/{collection}, /admin/c/{collection}/{id}, /admin/views/{view}, /admin/media or a standard Admin page. This only changes the displayed page.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } },
];
export function adminPath(path: unknown): string {
  if (typeof path !== "string" || !/^\/admin(?:\/|\?|$)/u.test(path) || /[\\#\r\n]/u.test(path)) throw new TypeError("Expected an Admin page path.");
  const url = new URL(path, "https://admin.invalid");
  if (url.origin !== "https://admin.invalid" || !/^\/admin(?:\/|$)/u.test(url.pathname) || /^\/admin\/(?:api|auth)(?:\/|$)/u.test(url.pathname)) throw new TypeError("Expected an Admin page path.");
  return url.pathname + url.search;
}
export function resultPath(catalog: AdminToolCatalog, name: string, output: unknown): string | undefined {
  const row = output && typeof output === "object" ? output as Record<string, unknown> : {};
  let route = catalog.routes[name];
  if (["request_publish", "unpublish_entry", "archive_entry"].includes(name) && typeof row.collection === "string") route = { path: `/admin/c/${encodeURIComponent(row.collection)}`, entry: true };
  if (!route) return;
  const path = route.path + (route.entry && typeof row.id === "string" ? `/${encodeURIComponent(row.id)}` : "");
  return adminPath(path + (route.entry && typeof row.status === "string" ? `?status=${encodeURIComponent(row.status)}` : ""));
}
/** What a tool call answers a WebMCP host: the output as structured content when it is an object, and as JSON text. */
export interface AdminToolResult {
  isError?: true;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/** What a failed call answers a WebMCP host: the message, then, as for MCP, the deployed tool version and the input
 *  schema the tool is listed with now when the refusal names them; the diagnostic stays structured. */
export function toolFailure(error: unknown): AdminToolResult {
  const diagnostic = error && typeof error === "object" && "body" in error ? error.body : undefined;
  const { toolVersion, inputSchema } = (diagnostic && typeof diagnostic === "object" ? diagnostic : {}) as { toolVersion?: unknown; inputSchema?: unknown };
  const about = [typeof toolVersion === "string" && `tool version ${toolVersion}`, inputSchema !== undefined && `input schema ${JSON.stringify(inputSchema)}`].filter(Boolean).join("; ");
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Admin tool failed." }, ...(about ? [{ type: "text" as const, text: about }] : [])],
    ...(diagnostic !== undefined ? { structuredContent: { diagnostic } } : {}) };
}

/** Call an admin tool once on Admin's tool route (`POST /admin/api/webmcp/{tool}`), with the signed-in session. A refusal
 *  keeps its Mantle diagnostic, and nothing is retried: a write whose outcome is unknown must be re-read. */
export async function callAdminTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: AdminToolResult; output: unknown }> {
  let output: unknown, version: string | undefined;
  try {
    ({ output, version } = await api.post<{ output: unknown; version?: string }>(`/webmcp/${encodeURIComponent(name)}`, input, { signal }));
  } catch (error) {
    // the diagnostic is the refusal; the body stays a plain, serialisable object
    if (error instanceof ApiError) throw new ApiError(error.message, error.status, refusalOf(error.body) ?? error.body);
    throw error;
  }
  const result: AdminToolResult = { content: [{ type: "text", text: JSON.stringify(output) }, ...(version ? [{ type: "text" as const, text: `tool version ${version}` }] : [])], ...(output && typeof output === "object" && !Array.isArray(output) ? { structuredContent: output as Record<string, unknown> } : {}) };
  return { result, output };
}
