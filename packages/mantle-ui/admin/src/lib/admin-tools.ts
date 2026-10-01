import { api, ApiError, refusalOf } from "./api";

export interface AdminTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}
export interface AdminToolCatalog {
  tools: AdminTool[];
  /** What runs each staff tool: its Procedure through Admin's operation route, or its View through Admin's View route. */
  calls: Record<string, { kind: "procedure" | "view"; source: string }>;
  routes: Record<string, { path: string; entry?: boolean }>;
}
export interface AdminModelContext {
  registerTool(tool: AdminTool & { execute(input: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<unknown> }, options: { signal: AbortSignal }): void | Promise<void>;
}
export const navigationTools: AdminTool[] = [
  { name: "admin_get_context", description: "Read the current Admin page and available staff tools. Call before navigating or changing data.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "admin_navigate", description: "Navigate to a same-origin Admin page. Use /admin/c/{collection}, /admin/c/{collection}/{id}, /admin/views/{view}, /admin/media or a standard Admin page. This only changes the displayed page.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true } },
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
export interface StaffToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/** Call a staff tool once, on Admin's own routes with the signed-in session. A refusal keeps its Mantle diagnostic, and
 *  nothing is retried: a write whose outcome is unknown must be re-read. */
export async function callStaffTool(catalog: AdminToolCatalog, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: StaffToolResult; output: unknown }> {
  const call = Object.prototype.hasOwnProperty.call(catalog.calls, name) ? catalog.calls[name] : undefined;
  if (!call) throw new TypeError("Unknown staff tool.");
  const source = encodeURIComponent(call.source);
  let output: unknown;
  try {
    if (call.kind === "procedure") output = (await api.post<{ output: unknown }>(`/operations/${source}`, input, { signal })).output;
    else output = await api.get(`/views/${source}${viewQuery(input)}`, { signal });
  } catch (error) {
    // the diagnostic is the refusal; the body stays a plain, serialisable object
    if (error instanceof ApiError) throw new ApiError(error.message, error.status, refusalOf(error.body) ?? error.body);
    throw error;
  }
  const result: StaffToolResult = { content: [{ type: "text", text: JSON.stringify(output) }], ...(output && typeof output === "object" && !Array.isArray(output) ? { structuredContent: output as Record<string, unknown> } : {}) };
  return { result, output };
}

/** A View tool's input as the View route reads it: one query parameter each, `limit` and `cursor` included. */
function viewQuery(input: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    query.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
