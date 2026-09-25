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
  /** RFC 9728 metadata URL advertised on scope challenges. */
  readonly resourceMetadataUrl?: string;
  /**
   * Open 2026-era `subscriptions/listen` streams allowed per handler. Mantle
   * publishes no change events, so a stream only idles; the bound keeps
   * anonymous listeners from holding requests open without limit. Defaults
   * to 32.
   */
  readonly maxSubscriptions?: number;
}

export interface MantleMcpHandler {
  /** Serve one request for a caller the adapter has already verified. */
  fetch(request: Request, ctx: HandlerContext): Promise<Response>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_SUBSCRIPTIONS = 32;
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
      maxSubscriptions: options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
      onerror: (error) => console.error("[mantle-mcp] request failed", error),
    },
  );

  return {
    async fetch(request, ctx) {
      const authInfo = toAuthInfo(ctx, options.resourceMetadataUrl);
      if (request.method.toUpperCase() !== "POST" || !isJsonContentType(request.headers.get("content-type"))) {
        return sdk.fetch(request, { authInfo });
      }
      let text: string;
      try {
        const body = await readRequestBody(request.clone(), maxRequestBodySize);
        if (body.tooLarge) return payloadTooLarge(maxRequestBodySize);
        text = body.text;
      } catch {
        // An unreadable stream is the SDK's to answer.
        return sdk.fetch(request, { authInfo });
      }
      const message = parseJson(text);
      // Unparseable bodies go to the SDK untouched so it answers with its
      // own JSON-RPC parse error.
      if (message === undefined) return sdk.fetch(request, { authInfo });
      // A 2025-era batch carries several calls; every one is checked.
      const calls = (Array.isArray(message) ? message : [message]).flatMap(toolCall);
      const refused = calls.filter(({ name }) => {
        const capability = invoker.catalog.get(name);
        return capability?.requiresIdentity === true && isAnonymous(ctx);
      });
      if (refused.length > 0) {
        // The whole request is refused, so no call in it runs; each is recorded.
        for (const call of calls) servers.audit(ctx, call.name, call.args, "UNAUTHENTICATED");
        return options.unauthenticated
          ? options.unauthenticated(request)
          : new Response(null, { status: 401 });
      }
      // Registered tools audit themselves; anything else is a probe.
      for (const call of calls) {
        if (!invoker.serves(call.name)) servers.audit(ctx, call.name, call.args, "UNKNOWN_TOOL");
      }
      return sdk.fetch(request, { authInfo, parsedBody: message });
    },
    close: () => sdk.close(),
  };
}

function toAuthInfo(ctx: HandlerContext, resourceMetadataUrl: string | undefined): AuthInfo {
  return {
    // Mantle forwards the verified caller, never the raw credential.
    token: "",
    clientId: ctx.auth?.clientId ?? "",
    scopes: [...(ctx.auth?.scopes ?? [])],
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
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

/** A `tools/call` request, as zero or one call. Notifications (no `id`)
 *  never run a tool, so they are not calls. */
function toolCall(message: unknown): { name: string; args: Record<string, unknown> }[] {
  if (!isRecord(message) || message["method"] !== "tools/call" || !("id" in message)) return [];
  const params = message["params"];
  if (!isRecord(params) || typeof params["name"] !== "string") return [];
  return [{ name: params["name"], args: isRecord(params["arguments"]) ? params["arguments"] : {} }];
}

/** Same shape as the SDK's own oversize answer. */
function payloadTooLarge(limit: number): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: `Request body exceeds the ${limit}-byte limit.` },
  }), { status: 413, headers: { "content-type": "application/json" } });
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
