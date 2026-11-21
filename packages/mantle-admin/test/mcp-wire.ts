/**
 * One MCP request in either era Core serves. 2026-07-28 (the default): the `_meta` envelope in the body (what the params
 * already declare in `_meta` wins) and the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers that state the
 * same; it declares MCP Apps support unless `capabilities` says otherwise. `era: "2025-11-25"`: the stateless 2025 form,
 * plain JSON-RPC with the revision header and no envelope (no capabilities: MCP Apps support is unknown, so Apps stay
 * offered).
 */
export const APPS_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};
export const ERAS = ["2025-11-25", "2026-07-28"] as const;
export function mcpInit(
  method: string,
  params: Record<string, unknown> = {},
  {
    headers = {},
    capabilities = APPS_CAPABILITIES,
    era = "2026-07-28",
  }: { headers?: Record<string, string>; capabilities?: object; era?: (typeof ERAS)[number] } = {},
): RequestInit {
  if (era !== "2026-07-28")
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": era,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    };
  const name = method === "tools/call" ? params.name : method === "resources/read" ? params.uri : undefined;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": capabilities,
          ...meta,
        },
      },
    }),
  };
}
