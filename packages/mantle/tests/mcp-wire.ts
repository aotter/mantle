/**
 * Requests in either MCP protocol era Core serves. 2026-07-28: every request carries the `_meta` envelope (protocol
 * version, client info, client capabilities) and the `MCP-Protocol-Version`, `Mcp-Method` and, for a call or a read,
 * `Mcp-Name` headers. 2025 revisions: plain JSON-RPC, stateless (`legacyInit`, `eraRequest`). Tests build raw requests
 * with these instead of hand-rolling JSON-RPC. No SDK import: a Worker test bundle imports it too (`mcp-client.ts` has
 * the official client).
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

/** The 2025-era revision legacy helpers send (stateless: no session, no envelope). */
export const LEGACY_REVISION = "2025-11-25";
/** Both eras Core serves, for behaviour that must hold on each. */
export const ERAS = [LEGACY_REVISION, MCP_REVISION] as const;
export type Era = (typeof ERAS)[number];

/** A 2025-era handshake, as a client that does not speak 2026-07-28 opens. */
export const legacyInitialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: LEGACY_REVISION, capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
} as const;

/**
 * A POST `RequestInit` for a message (or a 2025-era batch) in the 2025 form: the body as given, no `_meta` envelope,
 * and the `MCP-Protocol-Version` header a client sends after `initialize`. `headers` are added after.
 */
export function legacyInit(message: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LEGACY_REVISION,
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
    body: typeof message === "string" ? message : JSON.stringify(message),
  };
}

/** The same logical message in either era's form: `mcpInit` on 2026-07-28 (declaring MCP Apps), `legacyInit` otherwise. */
export function eraInit(era: Era, message: unknown, init: RequestInit = {}): RequestInit {
  return era === MCP_REVISION ? mcpInit(message, init) : legacyInit(message, init);
}

/**
 * A `Request` for one method call at `url` in either era. On 2026-07-28 `capabilities` go in the envelope (none
 * declared by default); on a 2025 revision they are not sent (a stateless call carries none) unless the method is
 * `initialize`, which takes them in its params.
 */
export function eraRequest(
  era: Era,
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  init: RequestInit & { id?: number | string; capabilities?: object } = {},
): Request {
  if (era === MCP_REVISION) return mcpRequest(url, method, params, init);
  const { id = 1, capabilities, ...rest } = init;
  return new Request(url, legacyInit({ jsonrpc: "2.0", id, method, params }, rest));
}

/** The connect step of each era: `initialize` (2025) or `server/discover` (2026-07-28). */
export const connectMethod = (era: Era): string => (era === MCP_REVISION ? "server/discover" : "initialize");
/** The connect step's params: a 2025-era `initialize` names its revision, capabilities and client. */
export const connectParams = (era: Era, capabilities: object = {}): Record<string, unknown> =>
  era === MCP_REVISION
    ? {}
    : { protocolVersion: LEGACY_REVISION, capabilities, clientInfo: { name: "test", version: "1" } };
