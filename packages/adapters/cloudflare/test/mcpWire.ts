/**
 * Streamable HTTP wire helpers for tests that speak raw JSON-RPC to an MCP
 * endpoint. Clients must accept both JSON and SSE, and a 2025-era stateless
 * answer may arrive as a one-event SSE stream.
 */
export const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-11-25",
} as const;

export async function readJsonRpc<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  const data = /^(?:event|data|id|retry):/mu.test(text)
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("")
    : text;
  return JSON.parse(data) as T;
}

/** The JSON text block of a tool result, parsed. */
export function toolText<T = unknown>(result: { content?: readonly { type: string; text?: string }[] }): T {
  const text = result.content?.find((item) => item.type === "text")?.text;
  return JSON.parse(text ?? "null") as T;
}
