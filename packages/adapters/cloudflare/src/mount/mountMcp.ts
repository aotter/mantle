import { McpJsonRpcDispatcher } from "@aotter/mantle-runtime";
import type { ProcedureManifest } from "@aotter/mantle-spec";
import { DPOP_SIGNING_ALGORITHMS } from "better-auth/oauth2";
import type { MantleRuntimeRef } from "./bootRuntimeOnce.js";
import { contextForVerifiedUser } from "./resolveCaller.js";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";

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
      const rejected = rejectCrossOriginMutation(request);
      if (rejected) return rejected;
      const verified = await ref.auth.verifyOAuthAccessToken(request, {
        audience: resource,
        scopes: requiredScopes,
      });
      if (!verified.ok) return oauthDenied(resource, requiredScopes, verified);
      const grantedScopes = verified.scopes;
      const waitUntil = typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
      const handlerContext = await contextForVerifiedUser(
        verified.userId,
        {
          credential: "oauth",
          credentialId: verified.credentialId,
          clientId: verified.clientId,
          scopes: grantedScopes,
        },
        ref.auth,
        { env, ...(waitUntil ? { waitUntil } : {}) },
      );
      if (surface === "staff" && !handlerContext.staff) {
        return oauthDenied(resource, requiredScopes, {
          status: 403,
          reason: "insufficient-scope",
        });
      }
      const runtime = await ref.get();
      // Media tools require BOTH a storage adapter AND a declared
      // `media.purposes` taxonomy (#262). Empty purposes →
      // create_media_upload would always fail-closed, so don't surface
      // the tools in tools/list at all. Read this before consulting the
      // dispatcher cache so operator edits to site_config update the
      // MCP catalog without a redeploy/runtime reset.
      const site = await runtime.siteConfig.load();
      const mediaPurposes = runtime.media ? site.media.purposes : [];
      // Serialise the whole policy set as the cache key — name + required
      // mimes + per-mime maxBytes all participate. Operator edits to any
      // of these (admin Settings → media taxonomy) rebuild the dispatcher
      // so tools/list reflects the latest contract without a redeploy.
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
            listEntries: runtime.listEntries,
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
            invokeProcedure: {
              execute: (request) => runtime.invokeProcedure({
                ...request,
                procedure: request.procedure.metadata.name,
              }),
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
            // A View belongs on surface S iff its declared surface
            // (default "public") matches — mirrors how procedures are
            // gated (#438). Without this, `surface: "staff"` Views leaked
            // into the public `/mcp` tools/list + tools/call.
            views: Object.values(ref.plan.views)
              .map(({ manifest }) => manifest)
              .filter((view) => view.spec.surface === surface),
            procedures: collectMcpProcedures(ref.plan, surface),
            serverInfo,
          },
        );
        cached = { configKey, dispatcher };
        dispatcherCache.set(runtime, cached);
      }
      return cached.dispatcher.dispatch(request, handlerContext);
    },
  };
}

function oauthDenied(
  resource: string,
  requiredScopes: readonly string[],
  denied: { readonly status: 401 | 403; readonly reason: string },
): Response {
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
  return Response.json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: denied.status === 403 ? "insufficient scope" : "unauthorized",
    },
    id: null,
  }, {
    status: denied.status,
    headers: {
      "www-authenticate":
        challenge,
      "access-control-expose-headers": "WWW-Authenticate",
    },
  });
}

/**
 * Collect Procedures bound to MCP Triggers on the given surface (#281).
 * The Trigger declares `source: { kind: "mcp", surface: "<staff|public>" }`;
 * we resolve `target.procedure` against the runtime's procedure map
 * and return only the matches. Triggers pointing at unknown procedures
 * are silently dropped here — boot validation already rejects those
 * with TRIGGER_TARGET_PROCEDURE_UNKNOWN before we get this far.
 */
function collectMcpProcedures(
  plan: MantleRuntimeRef["plan"],
  surface: "staff" | "public",
): readonly ProcedureManifest[] {
  const out: ProcedureManifest[] = [];
  for (const { manifest: t } of Object.values(plan.triggers)) {
    if (t.spec.source.kind !== "mcp") continue;
    if (t.spec.source.surface !== surface) continue;
    const p = plan.procedures[t.spec.target.procedure]?.manifest;
    if (p) out.push(p);
  }
  return out;
}
