/**
 * Conformance of Mantle's hand-written `/mcp` dispatcher against the official
 * MCP TypeScript client SDK 2.x (#1018).
 *
 * The server is deliberately not the SDK server: POST-only, `application/json`
 * only (415 is the cookie-session CSRF line), no session or SSE, `tools/call`
 * 401 with an OAuth challenge (#977, #983). This test proves an unmodified 2.x
 * `StreamableHTTPClientTransport` still completes initialize → tools/list →
 * tools/call on that server, and that its auth seam recovers from a
 * mid-session 401 the way the spec describes: read `WWW-Authenticate`, obtain a
 * token, retry the same request.
 */
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  extractWWWAuthenticateParams,
  type AuthProvider,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { Manifest } from "@aotter/mantle-spec";
import { InMemoryDatabase } from "../../../mantle-runtime/test/fakes/database.js";
import { createMantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { createMcpApiHandler } from "../src/mount/mountMcp.js";
import { compileTestPlan } from "./compileTestPlan.js";
import { StubAssetServer, stubAuth } from "./fakes/runtime-bindings.js";
import packageJson from "../package.json" with { type: "json" };

const apiVersion = "cms.mantle.aotter.net/v1" as const;
const ORIGIN = "https://example.test";
const MCP_RESOURCE = `${ORIGIN}/mcp`;
const STAFF_TOKEN = "staff-token";
const MEMBER_TOKEN = "member-token";

function manifests(): Manifest[] {
  const io = { type: "object", properties: { echo: { type: "string" } } } as const;
  return [
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "public-hello" },
      spec: { input: io, output: io, handler: { kind: "ref", ref: "hello" } },
    },
    {
      apiVersion,
      kind: "Procedure",
      metadata: { name: "member-hello" },
      spec: { input: io, output: io, requires: { auth: { all: ["ctx.user"] } }, handler: { kind: "ref", ref: "hello" } },
    },
    ...(["public-hello", "member-hello"] as const).flatMap((procedure) =>
      (["public", "staff"] as const).map((surface): Manifest => ({
        apiVersion,
        kind: "Trigger",
        metadata: { name: `${procedure}-${surface}-mcp` },
        spec: { source: { kind: "mcp", surface }, target: { procedure } },
      })),
    ),
  ];
}

function harness() {
  const seen: { request: Request; response: Response }[] = [];
  const ref = createMantleRuntimeRef({
    plan: compileTestPlan(manifests()),
    handlers: { hello: (input, ctx) => ({ echo: `${(input as { echo?: string }).echo ?? ""}:${ctx.user?.id ?? "anonymous"}`, }) },
    bindings: { db: new InMemoryDatabase(), adminAssets: new StubAssetServer() },
    auth: {
      ...stubAuth,
      // The staff role is re-read per call from the caller's identity.
      getUserRole: async (userId: string) => (userId === "staff-1" ? "owner" : null),
      verifyOAuthAccessToken: async (request: Request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
        const userId = token === STAFF_TOKEN ? "staff-1" : token === MEMBER_TOKEN ? "member-1" : null;
        return userId
          ? { ok: true as const, userId, clientId: "sdk-client", credentialId: token!, scopes: ["mcp"] }
          : { ok: false as const, status: 401 as const, reason: "invalid-token" };
      },
    },
  });
  const env = {};
  const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const bridge = (surface: "public" | "staff"): FetchLike => {
    const handler = createMcpApiHandler({ ref, surface, resource: MCP_RESOURCE });
    return async (input, init) => {
      const request = new Request(input, init);
      const response = await handler.fetch!(request.clone() as Parameters<NonNullable<typeof handler.fetch>>[0], env, executionCtx);
      seen.push({ request, response: response.clone() });
      return response;
    };
  };
  const connect = async (surface: "public" | "staff", authProvider?: AuthProvider) => {
    const client = new Client({ name: "conformance", version: packageJson.version });
    const transport = new StreamableHTTPClientTransport(new URL(surface === "public" ? "/mcp" : "/mcp/staff", ORIGIN), {
      fetch: bridge(surface),
      ...(authProvider ? { authProvider } : {}),
    });
    await client.connect(transport);
    return client;
  };
  return { seen, connect };
}

const staticToken = (token: string): AuthProvider => ({ token: async () => token });

describe("MCP SDK 2.x client against Mantle /mcp", () => {
  it("initializes, lists and calls a public tool anonymously", async () => {
    const { seen, connect } = harness();
    const client = await connect("public");
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["public_hello", "member_hello"]));
    const result = await client.callTool({ name: "public_hello", arguments: { echo: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ echo: "hi:anonymous" }) }]);
    // The 2.x client advertises SSE on every POST; the POST-only server must
    // not reject that Accept header (415 is reserved for non-JSON bodies).
    const posts = seen.filter(({ request }) => request.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const { request, response } of posts) {
      expect(request.headers.get("accept")).toContain("text/event-stream");
      expect(response.status).toBeLessThan(300);
    }
    expect(posts.some(({ request }) => request.headers.get("mcp-protocol-version"))).toBe(true);
    // After initialize the client opens the optional GET listening stream.
    // Mantle has no server-initiated messages: it answers 405 and the
    // client carries on, exactly as the Streamable HTTP spec allows.
    const gets = seen.filter(({ request }) => request.method === "GET");
    expect(gets.map(({ response }) => response.status)).toEqual([405]);
    await client.close();
  });

  it("recovers from a mid-session 401 through the SDK auth seam and retries the call", async () => {
    const { connect } = harness();
    let token: string | undefined;
    const challenges: { resourceMetadataUrl?: URL; scope?: string }[] = [];
    const provider: AuthProvider = {
      token: async () => token,
      onUnauthorized: async ({ response }) => {
        challenges.push(extractWWWAuthenticateParams(response));
        token = MEMBER_TOKEN;
      },
    };
    const client = await connect("public", provider);
    const result = await client.callTool({ name: "member_hello", arguments: { echo: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ echo: "hi:member-1" }) }]);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.resourceMetadataUrl?.href).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(challenges[0]!.scope).toBe("mcp");
    await client.close();
  });

  it("surfaces an unrecoverable 401 as an auth error without breaking the session", async () => {
    const { connect } = harness();
    const client = await connect("public", { token: async () => undefined, onUnauthorized: async () => {} });
    // The seam ran once, the retry was still 401: the SDK reports the HTTP fact.
    const failure = await client.callTool({ name: "member_hello", arguments: {} }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SdkHttpError);
    expect((failure as SdkHttpError).data).toMatchObject({ status: 401 });
    // The same transport keeps working for anonymous tools afterwards.
    const ok = await client.callTool({ name: "public_hello", arguments: { echo: "still" } });
    expect(ok.content).toEqual([{ type: "text", text: JSON.stringify({ echo: "still:anonymous" }) }]);
    await client.close();
  });

  it("admits a staff caller to /mcp/staff and refuses a member there", async () => {
    const { connect } = harness();
    const staff = await connect("staff", staticToken(STAFF_TOKEN));
    const tools = (await staff.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["public_hello", "member_hello"]));
    const result = await staff.callTool({ name: "member_hello", arguments: { echo: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ echo: "hi:staff-1" }) }]);
    await staff.close();

    await expect(connect("staff", staticToken(MEMBER_TOKEN))).rejects.toThrow();
  });
});
