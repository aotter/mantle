import { test, expect } from "bun:test";
import { ContractError, drainBody } from "../src/kernel/contracts.js";
import { nativeRest, type Route } from "../src/kernel/rest.js";
import { mcp } from "../src/kernel/mcp.js";

// A response sent over an unread POST body makes local `wrangler dev` break the connection, and the next request fails with
// "Network connection lost". Every surface answers a refusal before it reads the body, so each must drain it once it has answered.
const post = (path: string, body = "x".repeat(2048), headers: Record<string, string> = {}) => new Request(`https://app.test${path}`, { method: "POST", headers, body });

test("a refused REST request leaves no unread body", async () => {
  const route: Route<null> = { method: "POST", pattern: /^\/api\/x$/, keys: [], handle: async () => ({ ok: true }) } as Route<null>;
  const refuse = nativeRest([route], { db: () => null, caller: () => { throw new ContractError("UNAUTHENTICATED", "Sign in.", "rest"); } });
  const denied = post("/api/x");
  expect((await refuse(denied, {}))!.status).toBe(401);
  expect(denied.bodyUsed).toBe(true);
  const missing = post("/api/nowhere");
  expect((await refuse(missing, {}))!.status).toBe(404);
  expect(missing.bodyUsed).toBe(true);
  const other = new Request("https://app.test/health", { method: "POST", body: "x" });
  expect(await refuse(other, {})).toBeUndefined();
  expect(other.bodyUsed).toBe(false); // not this handler's request: the next handler still reads it
});

test("a refused MCP request leaves no unread body", async () => {
  const handle = mcp(() => [], { db: () => null, caller: () => ({ kind: "anonymous" }) });
  const denied = post("/mcp/admin");
  expect((await handle(denied, {}))!.status).toBe(401);
  expect(denied.bodyUsed).toBe(true);
});

test("the drain is bounded and skips what the app already consumed", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(600 * 1024)); } });
  await drainBody(new Request("https://app.test/x", { method: "POST", body: stream, duplex: "half" } as RequestInit));
  expect(pulled).toBeLessThan(5);
  const used = post("/x");
  await used.text();
  await drainBody(used);
  await drainBody(new Request("https://app.test/x"));
});
