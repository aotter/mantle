import { describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES, JsonBodyTooLargeError, readJsonBody } from "../src/infrastructure/http/readJsonBody.js";
import { McpJsonRpcDispatcher, type McpUseCases } from "../src/infrastructure/mcp/McpJsonRpcDispatcher.js";

describe("JSON transport byte limit", () => {
  it("accepts the exact boundary and UTF-8 characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify("é"));
    const request = new Request("https://site.test", { method: "POST",
      body: new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }),
      duplex: "half",
    } as RequestInit);
    expect(await readJsonBody(request)).toBe("é");
    expect(await readJsonBody(new Request("https://site.test", {
      method: "POST", body: '"' + "x".repeat(MAX_JSON_BODY_BYTES - 2) + '"',
    }))).toHaveLength(MAX_JSON_BODY_BYTES - 2);
  });

  it.each([undefined, "1"])("cancels an oversized stream regardless of Content-Length %s", async (length) => {
    const cancel = vi.fn();
    const request = new Request("https://site.test", {
      method: "POST", headers: length ? { "content-length": length } : {},
      body: new ReadableStream({
        pull(c) { c.enqueue(new Uint8Array(64 * 1024)); },
        cancel,
      }), duplex: "half",
    } as RequestInit);
    await expect(readJsonBody(request)).rejects.toBeInstanceOf(JsonBodyTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns 413 from MCP before invoking a tool, while malformed JSON stays a parse error", async () => {
    const dispatcher = new McpJsonRpcDispatcher({} as McpUseCases, []);
    const ctx = { user: null, staff: null, env: {} };
    const response = await dispatcher.dispatch(new Request("https://site.test/mcp", {
      method: "POST", body: JSON.stringify({ padding: "x".repeat(MAX_JSON_BODY_BYTES) }),
    }), ctx);
    expect(response.status).toBe(413);
    const malformed = await dispatcher.dispatch(new Request("https://site.test/mcp", {
      method: "POST", body: "{",
    }), ctx);
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
  });
});
