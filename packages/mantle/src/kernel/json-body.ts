/** Request-only JSON reader: bound bytes before copying or parsing, independent of UTF-8 chunk boundaries. */
export async function body(request: Request, limit: number, fail: (message: string) => never): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(limit) || limit < 1) fail("Body limit must be a positive safe integer.");
  const reader = request.body?.getReader();
  let bytes = new Uint8Array(0), length = 0;
  try {
    while (reader) {
      const {done, value} = await reader.read();
      if (done) break;
      const end = length + value.byteLength;
      if (end > limit) { await reader.cancel().catch(() => {}); fail(`Request body exceeds ${limit} bytes.`); }
      if (end > bytes.length) {
        const grown = new Uint8Array(Math.max(end, Math.min(limit, Math.max(1024, bytes.length * 2))));
        grown.set(bytes); bytes = grown;
      }
      bytes.set(value, length); length = end;
    }
  } finally { reader?.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)).trim() || "{}"); } catch { fail("Expected a JSON body."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a JSON object.");
  return value as Record<string, unknown>;
}
