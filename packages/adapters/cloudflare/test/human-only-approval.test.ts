/**
 * ADR-0029 D3: Core has no mandatory-approval mechanism, but the documented
 * pattern keeps an approval human-only today. A `readOnly: true` Schema blocks
 * generic writes, and the approval Procedure has only an HTTP Trigger, so no
 * MCP catalog lists it and an MCP token cannot reach it over REST.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { createMcpApiHandler } from "../src/mount/mountMcp.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";
import { MCP_HEADERS, readJsonRpc } from "./mcpWire.js";
import { mountTestEndpoints } from "./mountTestEndpoints.js";

const apiVersion = "cms.mantle.aotter.net/v1" as const;
const MCP_RESOURCE = "https://example.test/mcp";

function manifests(): Manifest[] {
  return [
    {
      apiVersion,
      kind: "Schema",
      metadata: { name: "payouts" },
      spec: {
        title: "Payouts",
        lifecycle: "operational",
        schema: { type: "object", readOnly: true, properties: { payoutStatus: { type: "string" } } },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "approve-payout" },
      spec: {
        requires: { auth: { all: [{ "ctx.staff": ["owner"] }] } },
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        output: { type: "object" },
        handler: { kind: "ref", ref: "approvePayout" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "approve-payout-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/payouts/approve" },
        target: { procedure: "approve-payout" },
      },
    },
  ];
}

function harness(jwtBearer?: { audience: string; scopes: string[] }) {
  const approvePayout = vi.fn(() => ({ approved: true }));
  // An MCP-audience token: the verifier accepts it only for the MCP resource.
  const verifyOAuthAccessToken = vi.fn(async (_request: Request, options: { audience: string }) =>
    options.audience === MCP_RESOURCE
      ? { ok: true as const, userId: "owner-1", clientId: "agent", credentialId: "jti-1", scopes: ["mcp"] }
      : { ok: false as const, status: 401 as const, reason: "invalid-token" });
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(manifests()),
    handlers: { approvePayout },
    bindings: { db: new InMemoryDatabase(), adminAssets: new StubAssetServer() },
    auth: { ...stubAuth, getUserRole: async () => "owner", verifyOAuthAccessToken },
    ...(jwtBearer ? { jwtBearer } : {}),
  });
  const app = new Hono();
  mountTestEndpoints(app, ref);
  const staffMcp = createMcpApiHandler({ ref, surface: "staff", resource: `${MCP_RESOURCE}` });
  const approve = () => app.request("/api/payouts/approve", {
    method: "POST",
    headers: { authorization: "Bearer mcp-access-token", "content-type": "application/json" },
    body: JSON.stringify({ id: "p1" }),
  });
  return { staffMcp, approve, approvePayout, verifyOAuthAccessToken };
}

describe("human-only approval pattern (ADR-0029 D3)", () => {
  it("lists neither the approval nor a generic write on any MCP surface", async () => {
    const { staffMcp } = harness();
    const response = await staffMcp.fetch!(new Request(MCP_RESOURCE + "/staff", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer mcp-access-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), {}, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const names = (await readJsonRpc<{ result: { tools: { name: string }[] } }>(response)).result.tools.map((tool) => tool.name);
    expect(names).not.toContain("approve_payout");
    expect(names.filter((name) => name.endsWith("_payouts"))).toEqual([]);
  });

  it("refuses an MCP token on the HTTP Trigger by default", async () => {
    const { approve, approvePayout } = harness();
    expect((await approve()).status).toBe(401);
    expect(approvePayout).not.toHaveBeenCalled();
  });

  it("refuses an MCP-audience token when REST accepts OAuth for its own audience", async () => {
    const { approve, approvePayout, verifyOAuthAccessToken } = harness({ audience: "https://example.test/api", scopes: ["api"] });
    expect((await approve()).status).toBe(401);
    expect(verifyOAuthAccessToken).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ audience: "https://example.test/api" }));
    expect(approvePayout).not.toHaveBeenCalled();
  });
});
