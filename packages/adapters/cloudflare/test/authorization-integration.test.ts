import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DiagnosticError,
  runtimeDiagnostic,
  type Manifest,
} from "@aotter/mantle-spec";
import type { HandlerFn } from "@aotter/mantle-runtime";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { createCmsRef } from "../src/mount/bootRuntimeOnce.js";
import { createMcpApiHandler } from "../src/mount/mountMcp.js";
import { mountServerEndpoints } from "../src/mount/mountServerEndpoints.js";
import {
  StubAssetServer,
  stubAuth,
} from "./fakes/runtime-bindings.js";

const apiVersion = "cms.mantle.aotter.net/v1" as const;
const guide = readFileSync(
  new URL("../../../../docs/api-mcp-authorization.md", import.meta.url),
  "utf8",
);

function manifests(): Manifest[] {
  return [
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "require-active-membership" },
      spec: {
        input: {
          type: "object",
          properties: { accountId: { type: "string" } },
          required: ["accountId"],
        },
        output: { type: "object" },
        handler: { kind: "ref", ref: "requireActiveMembership" },
      },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "read-account" },
      spec: {
        input: {
          type: "object",
          properties: { accountId: { type: "string" } },
          required: ["accountId"],
        },
        output: {
          type: "object",
          properties: { accountId: { type: "string" } },
          required: ["accountId"],
        },
        requires: {
          auth: {
            all: ["ctx.user", "ctx.auth", { "ctx.auth.scope": "accounts:read" }],
          },
          guard: { procedure: "require-active-membership" },
        },
        handler: { kind: "ref", ref: "readAccount" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "read-account-http" },
      spec: {
        source: { kind: "http", method: "POST", path: "/api/accounts/read" },
        target: { procedure: "read-account" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "read-account-staff-mcp" },
      spec: {
        source: { kind: "mcp", surface: "staff" },
        target: { procedure: "read-account" },
      },
    },
    {
      apiVersion,
      kind: "Trigger",
      metadata: { name: "read-account-mcp" },
      spec: {
        source: { kind: "mcp", surface: "public" },
        target: { procedure: "read-account" },
      },
    },
  ];
}

function mcpCall(): Request {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "read_account",
        arguments: { accountId: "acct-1" },
      },
    }),
  });
}

describe("authorization integration: one target across REST and MCP", () => {
  it("keeps the shipped four-scenario guide aligned with the public seams", () => {
    for (const text of [
      "## 1. Anonymous public API",
      "## 2. Public API requiring an API key",
      "## 3. API key plus a mutable paid/transaction guard",
      "## 4. Personal token with user scope, shared by REST and MCP semantics",
      "ConsumerCredentialResolver",
      "credentialResolver: siteCredentialResolver(env.DB)",
      "createMcpApiHandler({ ref: runtimeRef, surface: \"public\" })",
      "getProviderAccessToken(request, \"mantle-platform\")",
      "verifyOAuthAccessToken(request",
      "x-mantle-guard-procedure",
      "ENTITLEMENT_REQUIRED",
    ]) {
      expect(guide, `missing guide contract: ${text}`).toContain(text);
    }
  });

  it("re-runs the same mutable site guard after PAT/OAuth caller normalization", async () => {
    let entitled = true;
    let targetCalls = 0;
    let guardCalls = 0;
    const mcpWaitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const workerEnv = { ENTITLEMENT_SOURCE: "worker-env" };
    const readAccount: HandlerFn<
      { accountId: string },
      { accountId: string },
      typeof workerEnv
    > = (input, ctx) => {
      targetCalls++;
      expect(ctx.env.ENTITLEMENT_SOURCE).toBe("worker-env");
      ctx.waitUntil?.(Promise.resolve());
      return input;
    };
    const ref = createCmsRef({
      manifests: manifests(),
      handlers: {
        requireActiveMembership: (_input, ctx) => {
          guardCalls++;
          expect(ctx.user?.id).toBe("user-1");
          expect(ctx.env.ENTITLEMENT_SOURCE).toBe("worker-env");
          if (!entitled) {
            throw new DiagnosticError(
              runtimeDiagnostic({
                code: "ENTITLEMENT_REQUIRED",
                severity: "error",
                path: "site:memberships/user-1",
                message: "Active membership required.",
              }),
            );
          }
          return {};
        },
        readAccount,
      },
      bindings: {
        db: new InMemoryDatabase(),
        assets: new StubAssetServer(),
      },
      auth: { ...stubAuth, getUserRole: async () => "owner" },
      credentialResolver: (request) => {
        const header = request.headers.get("authorization");
        if (header === null) return { kind: "not-handled" };
        if (header !== "Bearer site_pat_1") return { kind: "invalid" };
        return {
          kind: "verified",
          credential: {
            credential: "personal-token",
            credentialId: "pat-row-1",
            userId: "user-1",
            scopes: ["accounts:read"],
          },
        };
      },
    });
    const app = new Hono<{ Bindings: typeof workerEnv }>();
    mountServerEndpoints(app, ref);
    const publicMcp = createMcpApiHandler<typeof workerEnv>({ ref, surface: "public" });
    const staffMcp = createMcpApiHandler<typeof workerEnv>({ ref, surface: "staff" });
    const mcpContext = {
      props: {
        userId: "user-1",
        clientId: "personal-client",
        scopes: ["mcp", "accounts:read"],
      },
      waitUntil: mcpWaitUntil,
    } as unknown as ExecutionContext;

    const restGranted = await app.request(
      "/api/accounts/read",
      {
        method: "POST",
        headers: {
          authorization: "Bearer site_pat_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: "acct-1" }),
      },
      workerEnv,
    );
    expect(restGranted.status).toBe(200);
    for (const mcp of [publicMcp, staffMcp]) {
      const mcpGranted = await mcp.fetch!(mcpCall(), workerEnv, mcpContext);
      const mcpGrantedBody = (await mcpGranted.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      expect(JSON.parse(mcpGrantedBody.result?.content?.[0]?.text ?? "{}")).toEqual({
        accountId: "acct-1",
      });
    }
    expect(mcpWaitUntil).toHaveBeenCalledTimes(2);
    expect({ guardCalls, targetCalls }).toEqual({ guardCalls: 3, targetCalls: 3 });

    mcpContext.props.scopes = ["mcp"];
    const downscoped = await publicMcp.fetch!(mcpCall(), workerEnv, mcpContext);
    const downscopedBody = (await downscoped.json()) as {
      error?: { data?: { code?: string } };
    };
    expect(downscopedBody.error?.data?.code).toBe("AUTH_DENIED");
    expect({ guardCalls, targetCalls }).toEqual({ guardCalls: 3, targetCalls: 3 });
    mcpContext.props.scopes = ["mcp", "accounts:read"];

    entitled = false;
    const restDenied = await app.request(
      "/api/accounts/read",
      {
        method: "POST",
        headers: {
          authorization: "Bearer site_pat_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: "acct-1" }),
      },
      workerEnv,
    );
    expect(restDenied.status).toBe(402);
    const mcpDenied = await publicMcp.fetch!(mcpCall(), workerEnv, mcpContext);
    const mcpDeniedBody = (await mcpDenied.json()) as {
      error?: { data?: { code?: string } };
    };
    expect(mcpDeniedBody.error?.data?.code).toBe("ENTITLEMENT_REQUIRED");
    expect({ guardCalls, targetCalls }).toEqual({ guardCalls: 5, targetCalls: 3 });
  });
});
