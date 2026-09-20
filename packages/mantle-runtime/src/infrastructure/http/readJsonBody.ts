/** JSON control-plane payloads; media bytes use the direct-upload transport. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class JsonBodyTooLargeError extends Error {
  constructor() {
    super("JSON request body exceeds 1 MiB.");
    this.name = "JsonBodyTooLargeError";
  }
}

/** Count actual bytes, including requests without a trustworthy Content-Length. */
export async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) return JSON.parse("");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        // Do not wait for a remote producer (or a tee's other branch) to finish.
        void reader.cancel().catch(() => {});
        throw new JsonBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
