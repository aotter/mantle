import { ApiError } from "./api";

export interface AdminTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}
export interface AdminToolCatalog {
  tools: AdminTool[];
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
export async function callStaffTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: unknown; output: unknown }> {
  const response = await fetch("/admin/api/mcp", {
    method: "POST", credentials: "same-origin", signal,
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new ApiError(body.error?.message ?? "Admin tool failed.", response.status, body.error?.data ?? body);
  const result = body.result;
  const text = result?.content?.find((item: { type: string }) => item.type === "text")?.text;
  return { result, output: typeof text === "string" ? JSON.parse(text) : result };
}
