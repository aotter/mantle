/**
 * One request in MCP protocol revision 2026-07-28, the only one Core serves: the `_meta` envelope in the body (what the
 * params already declare in `_meta` wins) and the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers that state
 * the same. It declares MCP Apps support unless `capabilities` says otherwise.
 */
export const APPS_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};
export function mcpInit(
  method: string,
  params: Record<string, unknown> = {},
  { headers = {}, capabilities = APPS_CAPABILITIES }: { headers?: Record<string, string>; capabilities?: object } = {},
): RequestInit {
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
