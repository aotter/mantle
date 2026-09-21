import {
  McpJsonRpcDispatcher,
  projectCallableCapabilities,
} from "@aotter/mantle-runtime";
import { DPOP_SIGNING_ALGORITHMS } from "better-auth/oauth2";
import type { MantleRuntimeRef } from "./bootRuntimeOnce.js";
import { gateCaller } from "./resolveCaller.js";

import { beginDiagnosticPhase, diagnosticPhase, requestDiagnosticContext } from "../requestDiagnostics.js";

export interface CreateMcpApiHandlerOptions {
  readonly ref: MantleRuntimeRef;
  readonly surface: "staff" | "public";
  /** Canonical RFC 8707/9728 protected resource bound into access-token aud. */
  readonly resource: string;
  /** OAuth scopes required to enter this MCP resource. Defaults to
   *  the existing compatibility scope `mcp`. Target-specific scopes
   *  remain manifest predicates enforced on tools/call. */
  readonly requiredScopes?: readonly string[];
}

/**
 * Build a Cloudflare Worker `ExportedHandler` that serves one MCP path.
 * Better Auth issues resource-bound JWTs; this adapter verifies the token then
 * re-reads the caller's mutable staff role from D1 on every invocation.
 *
 * Note: OAuth scope distinction (`mcp:read` vs `mcp:staff`) used to
 * differentiate surfaces here. Removed because claude.ai's MCP client
 * silently omits `scope=` from /authorize when scopes contain colons,
 * which broke the consent flow. Staff vs public is now purely D1-role
 * driven.
 */
export function createMcpApiHandler<Env = Record<string, unknown>>(
  options: CreateMcpApiHandlerOptions,
): ExportedHandler<Env> {
  const { ref, surface, resource } = options;
  const requiredScopes = options.requiredScopes ?? ["mcp"];
  // Key the cached dispatcher to the runtime identity. Without this,
  // if `ref.get()` rejects + resets and the next call returns a new
  // runtime instance, the cached dispatcher would silently keep
  // pointing at the pre-reset use-cases. A WeakMap also lets the GC
  // reclaim the dispatcher if the runtime is replaced.
  const dispatcherCache = new WeakMap<object, {
    readonly configKey: string;
    readonly dispatcher: McpJsonRpcDispatcher;
  }>();

  return {
    async fetch(request, env, ctx) {
      const waitUntil = typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
      // One gate for every transport (#977): consumer credential, OAuth bearer
      // or cookie session, in that order, then the surface's single rule.
      // `public` admits anonymous callers and leaves enforcement to each
      // tool's `requires`; `staff` needs `ctx.staff`. Denials keep the OAuth
      // challenge so a client without a token knows where to get one.
      const gate = await gateCaller(request, {
        auth: ref.auth,
        credentialResolver: ref.credentialResolver,
        jwtBearer: { audience: resource, scopes: requiredScopes },
        env,
        ...(waitUntil ? { waitUntil } : {}),
        phase: diagnosticPhase,
        surface,
      });
      if (gate.kind === "deny") return oauthDenied(resource, requiredScopes, gate);
      const handlerContext = gate.context;
      const runtime = await ref.get();
      // Media tools require BOTH a storage adapter AND a declared
      // `media.purposes` taxonomy (#262). Empty purposes →
      // create_media_upload would always fail-closed, so don't surface
      // the tools in tools/list at all. Read this before consulting the
      // dispatcher cache so operator edits to site_config update the
      // MCP catalog without a redeploy/runtime reset.
      const site = await diagnosticPhase("catalog", async () => {
        if (ref.mcpCatalogSiteConfig) return ref.mcpCatalogSiteConfig.loadCatalogSite(runtime);
        const record = requestDiagnosticContext.getStore();
        if (record) record.catalog.source = "binding-absent";
        return runtime.siteConfig.load();
      });
      const stopBuild = beginDiagnosticPhase("dispatcherBuild");
      let selectedDispatcher: McpJsonRpcDispatcher;
      try {
        const mediaPurposes = runtime.media ? site.media.purposes : [];
        // Serialise the whole policy set as the cache key — name + required
        // mimes + per-mime maxBytes all participate. Operator edits to any
        // of these rebuild the dispatcher when the discovery snapshot changes.
        // Upload authorization still reads the canonical policy on every call.
        const publicUrl = URL.canParse(site.origin) ? site.origin : new URL(request.url).origin;
        const iconBase = `${publicUrl}/`;
        const serverInfo = {
          name: `aotter.mantle.${surface}`,
          title: site.brand,
          description: site.description || undefined,
          websiteUrl: publicUrl,
          icons: site.icons.filter((icon) => URL.canParse(icon.src, iconBase)).map((icon) => ({
            ...icon,
            src: new URL(icon.src, iconBase).href,
          })),
        };
        const configKey = JSON.stringify({ mediaPurposes, serverInfo });
        let cached = dispatcherCache.get(runtime);
        if (!cached || cached.configKey !== configKey) {
          const mediaEnabled = runtime.media !== null && mediaPurposes.length > 0;
          const dispatcher = new McpJsonRpcDispatcher(
            {
              getEntry: runtime.getEntry,
              createDraft: runtime.createDraft,
              updateDraft: runtime.updateDraft,
              requestPublish: runtime.requestPublish,
              unpublish: runtime.unpublish,
              archive: runtime.archive,
              deleteEntry: runtime.deleteEntry,
              executeView: {
                execute: (request) => runtime.executeView({
                  ...request,
                  view: request.view.metadata.name,
                }),
              },
              invokeTrigger: {
                execute: (request) => runtime.invokeTrigger(request),
              },
              media: mediaEnabled && runtime.media
                ? {
                    createUpload: runtime.media.createUpload,
                    commitUpload: runtime.media.commitUpload,
                    purposes: mediaPurposes,
                  }
                : undefined,
            },
            [...runtime.schemas.values()],
            {
              surface,
              capabilities: projectCallableCapabilities(ref.plan, { surface }),
              serverInfo,
            },
          );
          cached = { configKey, dispatcher };
          dispatcherCache.set(runtime, cached);
        }
        selectedDispatcher = cached.dispatcher;
      } finally { stopBuild(); }
      const response = await diagnosticPhase("dispatch", () => selectedDispatcher.dispatch(request, handlerContext));
      return withChallenge(response, resource, requiredScopes);
    },
  };
}

function challengeHeaders(
  resource: string,
  requiredScopes: readonly string[],
  denied: { readonly status: 401 | 403; readonly reason?: string },
): Record<string, string> {
  const scope = requiredScopes.join(" ");
  const resourceUrl = new URL(resource);
  const resourcePath = resourceUrl.pathname.replace(/\/$/u, "");
  const metadata = new URL(
    `/.well-known/oauth-protected-resource${resourcePath}`,
    resourceUrl.origin,
  ).href;
  const error = denied.status === 403 ? "insufficient_scope" : "invalid_token";
  const challenge = denied.reason === "invalid-dpop-proof"
    ? `DPoP error="invalid_dpop_proof", algs="${DPOP_SIGNING_ALGORITHMS.join(" ")}"`
    : `Bearer realm="mcp", error="${error}", scope="${scope}", resource_metadata="${metadata}"`;
  return {
    "www-authenticate": challenge,
    "access-control-expose-headers": "WWW-Authenticate",
  };
}

function oauthDenied(
  resource: string,
  requiredScopes: readonly string[],
  denied: { readonly status: 401 | 403; readonly reason: string },
): Response {
  return Response.json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: denied.status === 403 ? "insufficient scope" : "unauthorized",
    },
    id: null,
  }, {
    status: denied.status,
    headers: challengeHeaders(resource, requiredScopes, denied),
  });
}

/** A tool that needs identity the caller lacks answers 401/403 from the
 *  dispatcher; add the OAuth challenge so the client can authenticate and
 *  retry instead of surfacing a dead JSON-RPC error. */
function withChallenge(response: Response, resource: string, requiredScopes: readonly string[]): Response {
  if ((response.status !== 401 && response.status !== 403) || response.headers.has("www-authenticate")) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(challengeHeaders(resource, requiredScopes, { status: response.status }))) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
