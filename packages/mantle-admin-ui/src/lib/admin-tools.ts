import type { CallToolResult, Client } from "@modelcontextprotocol/client";
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
/** One official MCP client per page, connected on first use; a failed
 *  connection is dropped so the next call reconnects. */
let staffClient: Promise<Client> | null = null;
function connectStaffClient(): Promise<Client> {
  staffClient ??= (async () => {
    // Loaded only when a WebMCP host or the preview bridge calls a tool.
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new Client({ name: "mantle-admin", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/admin/api/mcp", location.origin), {
      requestInit: { credentials: "same-origin" },
    }));
    return client;
  })().catch((error: unknown) => {
    staffClient = null;
    throw error;
  });
  return staffClient;
}

/** Call a staff tool once. A tool failure keeps its Mantle diagnostic, and
 *  nothing is retried: a write whose outcome is unknown must be re-read. */
export async function callStaffTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: unknown; output: unknown }> {
  let result: CallToolResult;
  try {
    const client = await connectStaffClient();
    result = await client.callTool({ name, arguments: input }, { signal });
  } catch (error) {
    const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : 0;
    throw new ApiError(error instanceof Error ? error.message : "Admin tool failed.", status, error);
  }
  const text = result.content?.find((item) => item.type === "text");
  const output: unknown = text && "text" in text ? JSON.parse(text.text) : result;
  if (result.isError) {
    const diagnostic = (output as { diagnostics?: readonly { message?: string }[] } | null)?.diagnostics?.[0];
    throw new ApiError(diagnostic?.message ?? "Admin tool failed.", 0, diagnostic ?? output);
  }
  return { result, output };
}
