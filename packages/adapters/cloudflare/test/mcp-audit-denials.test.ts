/** Gate denials on /mcp are audit events too (#1017): a token refused before
 *  the dispatcher runs must still leave a `tools/call` trail. */
import { describe, expect, it } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import type { McpToolCallAuditEvent } from "@aotter/mantle-runtime";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { createMcpApiHandler } from "../src/mount/mountMcp.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";

const apiVersion = "cms.mantle.aotter.net/v1" as const;
const RESOURCE = "https://example.test/mcp";

function manifests(): Manifest[] {
  const io = { type: "object", properties: {} } as const;
  return [
    { apiVersion, kind: "Procedure", metadata: { name: "hello" }, spec: { input: io, output: io, handler: { kind: "ref", ref: "hello" } } },
    { apiVersion, kind: "Trigger", metadata: { name: "hello-staff-mcp" }, spec: { source: { kind: "mcp", surface: "staff" }, target: { procedure: "hello" } } },
    { apiVersion, kind: "Trigger", metadata: { name: "hello-public-mcp" }, spec: { source: { kind: "mcp", surface: "public" }, target: { procedure: "hello" } } },
  ];
}

function call(path: string, token: string | null, method = "tools/call", params: unknown = { name: "hello", arguments: {} }) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("MCP audit: gate denials", () => {
  const events: McpToolCallAuditEvent[] = [];
  const deferred: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => { deferred.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(manifests()),
    handlers: { hello: () => ({}) },
    bindings: { db: new InMemoryDatabase(), adminAssets: new StubAssetServer() },
    audit: { record: (event) => { events.push(event); } },
    auth: {
      ...stubAuth,
      getUserRole: async () => null,
      verifyOAuthAccessToken: async (request: Request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
        if (token === "member") return { ok: true as const, userId: "member-1", clientId: "claude", credentialId: "t1", scopes: ["mcp"] };
        if (token === "narrow") return { ok: true as const, userId: "member-1", clientId: "claude", credentialId: "t2", scopes: ["frontend"] };
        return { ok: false as const, status: 401 as const, reason: "invalid-token" };
      },
    },
  });
  const staff = createMcpApiHandler({ ref, surface: "staff", resource: RESOURCE });
  const pub = createMcpApiHandler({ ref, surface: "public", resource: RESOURCE });
  const env = {};
  const run = async (handler: typeof staff, request: Request) => {
    const response = await handler.fetch!(request as never, env, executionCtx);
    await Promise.all(deferred.splice(0));
    return response;
  };

  it("records a member refused on the staff surface, with the identity the gate established", async () => {
    events.length = 0;
    const response = await run(staff, call("/mcp/staff", "member", "tools/call", { name: "hello", arguments: { operationId: "op-9" } }));
    expect(response.status).toBe(403);
    expect(events).toEqual([expect.objectContaining({
      surface: "staff", callerId: "member-1", clientId: "claude", credential: "oauth", tool: "hello", operationId: "op-9", outcome: "INSUFFICIENT_ROLE",
    })]);
  });

  it("reads a denied body through the 1 MiB bounded reader, so an unauthenticated caller cannot make the Worker buffer more", async () => {
    events.length = 0;
    // A chunked body with no trustworthy Content-Length: 2 MiB in 64 KiB pieces.
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 32) return controller.close();
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", authorization: "Bearer garbage" },
      body,
      // @ts-expect-error duplex is required by undici for streamed bodies
      duplex: "half",
    });
    const response = await run(pub, request);
    expect(response.status).toBe(401);
    expect(events).toEqual([]);
    // The reader stopped at the limit instead of draining the producer.
    expect(pulled).toBeLessThan(32);
  });

  it("records an invalid token and an insufficient scope", async () => {
    events.length = 0;
    expect((await run(pub, call("/mcp", "garbage"))).status).toBe(401);
    expect((await run(pub, call("/mcp", "narrow"))).status).toBe(403);
    expect(events.map((event) => [event.callerId, event.outcome])).toEqual([
      [null, "INVALID_TOKEN"],
      ["member-1", "INSUFFICIENT_SCOPE"],
    ]);
  });

  it("does not record denied discovery methods", async () => {
    events.length = 0;
    expect((await run(staff, call("/mcp/staff", "member", "tools/list", {}))).status).toBe(403);
    expect(events).toEqual([]);
  });

  it("still records the dispatcher outcome for an admitted call", async () => {
    events.length = 0;
    const response = await run(pub, call("/mcp", "member"));
    expect(response.status).toBe(200);
    expect(events).toEqual([expect.objectContaining({ surface: "public", callerId: "member-1", tool: "hello", outcome: "ok" })]);
  });
});
