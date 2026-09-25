import {
  createMcpHandler,
  isJsonContentType,
  readRequestBody,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { HandlerContext, InvokeCapabilityUseCase } from "@aotter/mantle-runtime";
import { createMantleMcpServer, type MantleMcpServerOptions } from "./createMantleMcpServer.js";

export interface MantleMcpHandlerOptions extends MantleMcpServerOptions {
  /**
   * Answer for an anonymous caller of a capability that `requiresIdentity`,
   * before any tool runs, so the client can authenticate and retry. Adapters
   * return their `401` with a `WWW-Authenticate` challenge here. Defaults to
   * a bare `401`.
   */
  readonly unauthenticated?: (request: Request) => Response | Promise<Response>;
  /** POST body bound in bytes. Defaults to 1 MiB. */
  readonly maxRequestBodySize?: number;
}

export interface MantleMcpHandler {
  /** Serve one request for a caller the adapter has already verified. */
  fetch(request: Request, ctx: HandlerContext): Promise<Response>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const CONTEXT_KEY = "mantle.handlerContext";
const ANONYMOUS: HandlerContext = Object.freeze({ user: null, staff: null, env: {} });

/**
 * Serve one capability surface over MCP with the official SDK: the 2026-07-28
 * per-request era and 2025-era stateless requests from one definition.
 *
 * The adapter owns identity: it verifies the caller and passes the resulting
 * `HandlerContext`, which reaches tools through the SDK's pass-through
 * `authInfo`. The SDK never sees or checks a token.
 */
export function createMantleMcpHandler(
  invoker: InvokeCapabilityUseCase,
  options: MantleMcpHandlerOptions = {},
): MantleMcpHandler {
  const servers = createMantleMcpServer(invoker, options);
  const maxRequestBodySize = options.maxRequestBodySize ?? DEFAULT_MAX_BODY;
  const sdk = createMcpHandler(
    ({ authInfo }) => servers.create(contextOf(authInfo)),
    {
      legacy: "stateless",
      maxRequestBodySize,
      onerror: (error) => console.error("[mantle-mcp] request failed", error),
    },
  );

  return {
    async fetch(request, ctx) {
      const authInfo = toAuthInfo(ctx);
      if (request.method.toUpperCase() !== "POST" || !isJsonContentType(request.headers.get("content-type"))) {
        return sdk.fetch(request, { authInfo });
      }
      const body = await readRequestBody(request.clone(), maxRequestBodySize);
      if (body.tooLarge) return new Response("Payload Too Large", { status: 413 });
      const message = parseJson(body.text);
      // Unparseable bodies go to the SDK untouched so it answers with its
      // own JSON-RPC parse error.
      if (message === undefined) return sdk.fetch(request, { authInfo });
      const call = toolCall(message);
      if (call) {
        const capability = invoker.catalog.get(call.name);
        if (!capability) {
          servers.audit(ctx, call.name, call.args, "UNKNOWN_TOOL");
        } else if (capability.requiresIdentity && isAnonymous(ctx)) {
          servers.audit(ctx, call.name, call.args, "UNAUTHENTICATED");
          return options.unauthenticated
            ? options.unauthenticated(request)
            : new Response(null, { status: 401 });
        }
      }
      return sdk.fetch(request, { authInfo, parsedBody: message });
    },
    close: () => sdk.close(),
  };
}

function toAuthInfo(ctx: HandlerContext): AuthInfo {
  return {
    // Mantle forwards the verified caller, never the raw credential.
    token: "",
    clientId: ctx.auth?.clientId ?? "",
    scopes: [...(ctx.auth?.scopes ?? [])],
    extra: { [CONTEXT_KEY]: ctx },
  };
}

function contextOf(authInfo: AuthInfo | undefined): HandlerContext {
  const ctx = authInfo?.extra?.[CONTEXT_KEY];
  return isRecord(ctx) ? ctx as unknown as HandlerContext : ANONYMOUS;
}

function isAnonymous(ctx: HandlerContext): boolean {
  return ctx.user === null && ctx.staff === null && ctx.auth === undefined;
}

function toolCall(message: unknown): { name: string; args: Record<string, unknown> } | undefined {
  if (!isRecord(message) || message["method"] !== "tools/call") return undefined;
  const params = message["params"];
  if (!isRecord(params) || typeof params["name"] !== "string") return undefined;
  return { name: params["name"], args: isRecord(params["arguments"]) ? params["arguments"] : {} };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
