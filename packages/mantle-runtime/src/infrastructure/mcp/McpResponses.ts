export function jsonRpcOk(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

export function jsonRpcOkRaw(id: unknown, resultJson: string): Response {
  const idJson = JSON.stringify(id);
  return new Response(`{"jsonrpc":"2.0","id":${idJson},"result":${resultJson}}`, {
    headers: { "content-type": "application/json" },
  });
}

export function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Response {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
    headers: { "content-type": "application/json" },
  });
}
