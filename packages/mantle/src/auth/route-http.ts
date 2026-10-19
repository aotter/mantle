/** Private-response helpers and the bounded body read shared by auth routes and the lazy consent module. */
import { ContractError } from "../kernel/contracts.js";

export const PRIVATE = { "cache-control": "private, no-store" };
export const CONSENT = new Set(["GET /oauth/consent", "GET /oauth/consent/data", "POST /oauth/consent", "GET /oauth/consents", "GET /oauth/consents/data", "POST /oauth/consents/revoke"]);
export const MAX_BODY = 1_048_576;
export const text = (body: string, status: number) => new Response(body, { status, headers: PRIVATE });
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE });
export const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location, ...PRIVATE } });
export const tooLarge = () => new ContractError("INPUT_VALIDATION_FAILED", "Request body exceeds 1 MiB.");

/** Bounded streaming read even without Content-Length; the native parser still owns JSON/form semantics. */
export async function readBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder(); let size = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel(); throw tooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
