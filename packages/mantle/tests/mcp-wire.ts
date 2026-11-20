/**
 * Requests in the one MCP protocol revision Core serves, 2026-07-28: every request carries the `_meta` envelope
 * (protocol version, client info, client capabilities) and the `MCP-Protocol-Version`, `Mcp-Method` and, for a call or
 * a read, `Mcp-Name` headers. Tests build raw requests with these instead of hand-rolling JSON-RPC. No SDK import: a
 * Worker test bundle imports it too (`mcp-client.ts` has the official client).
 */

export const MCP_REVISION = "2026-07-28";
export const APPS_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};
const PROTOCOL = "io.modelcontextprotocol/protocolVersion",
  CLIENT = "io.modelcontextprotocol/clientInfo",
  CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One request message. `params._meta` keeps what the caller put there and gains the envelope; `capabilities` are the
 * client capabilities it declares (`APPS_CAPABILITIES` for an MCP Apps host).
 */
export function mcpMessage(
  method: string,
  params: Record<string, unknown> = {},
  { id = 1, capabilities = {} as object }: { id?: number | string; capabilities?: object } = {},
): { jsonrpc: "2.0"; id: number | string; method: string; params: Record<string, unknown> } {
  const meta = isRecord(params._meta) ? params._meta : {};
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL]: MCP_REVISION,
        [CLIENT]: { name: "test", version: "1" },
        [CAPABILITIES]: capabilities,
        ...meta,
      },
    },
  };
}

/** The headers a message needs: JSON and SSE accepted, the revision, and the method and name the body states. */
export function mcpHeaders(message: unknown): Record<string, string> {
  const method = isRecord(message) && typeof message.method === "string" ? message.method : undefined,
    params = isRecord(message) && isRecord(message.params) ? message.params : {},
    name =
      method === "tools/call" || method === "prompts/get"
        ? params.name
        : method === "resources/read"
          ? params.uri
          : undefined;
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_REVISION,
    ...(method ? { "mcp-method": method } : {}),
    ...(typeof name === "string" ? { "mcp-name": name } : {}),
  };
}

/**
 * A POST `RequestInit` for a message, with `headers` added after the protocol's own. A JSON-RPC message object gains
 * the envelope in `params._meta`, declaring MCP Apps support unless the message declares its own client capabilities
 * there (what it declares wins); JSON text and anything else are sent as they are.
 */
export function mcpInit(message: unknown, init: RequestInit = {}): RequestInit {
  const modern =
    isRecord(message) &&
    typeof message.method === "string" &&
    (message.params === undefined || isRecord(message.params))
      ? {
          ...message,
          params: mcpMessage(message.method, isRecord(message.params) ? message.params : {}, {
            capabilities: APPS_CAPABILITIES,
          }).params,
        }
      : message;
  const parsed = typeof message === "string" ? safeParse(message) : modern;
  return {
    method: "POST",
    ...init,
    headers: { ...mcpHeaders(parsed), ...Object.fromEntries(new Headers(init.headers).entries()) },
    body: typeof message === "string" ? message : JSON.stringify(modern),
  };
}
const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A `Request` for one method call at `url`. */
export function mcpRequest(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  init: RequestInit & { id?: number | string; capabilities?: object } = {},
): Request {
  const { id, capabilities, ...rest } = init;
  return new Request(url, mcpInit(mcpMessage(method, params, { id, capabilities }), rest));
}

/** A 2025-era message, as a client that does not speak 2026-07-28 sends it: Core refuses these. */
export const legacyInitialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
} as const;
