import { McpJsonRpcDispatcher } from "@aotter/mantle-runtime";
import type { ProcedureManifest, TriggerManifest, ViewManifest } from "@aotter/mantle-spec";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";
import { contextForVerifiedUser } from "./resolveCaller.js";
import { rejectCrossOriginMutation } from "../auth/rejectCrossOriginMutation.js";

export interface CreateMcpApiHandlerOptions {
  readonly ref: CmsRuntimeRef;
  readonly surface: "staff" | "public";
  /** OAuth scopes required to enter this MCP resource. Defaults to
   *  the existing compatibility scope `mcp`. Target-specific scopes
   *  remain manifest predicates enforced on tools/call. */
  readonly requiredScopes?: readonly string[];
}

/**
 * Build a Cloudflare Worker `ExportedHandler` that serves one MCP
 * resource path. Plug into `createOAuthProvider({ apiHandlers })`
 * keyed by the resource path (e.g. `/mcp/staff` or `/mcp`).
 *
 * The OAuthProvider lib verifies the bearer token and sets its
 * token-specific identity and scopes on `ctx.props` BEFORE calling
 * this handler. We re-read the caller's mutable staff role from D1
 * on every invocation.
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
  const { ref, surface } = options;
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
      const props = readOAuthApiProps((ctx as unknown as { props?: unknown }).props);
      if (!props) return forbidden(requiredScopes);
      const grantedScopes = props.scopes;
      if (requiredScopes.some((scope) => !grantedScopes.includes(scope))) {
        return forbidden(requiredScopes);
      }
      const waitUntil = typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
      const handlerContext = await contextForVerifiedUser(
        props.userId,
        {
          credential: "oauth",
          credentialId: null,
          clientId: props.clientId,
          scopes: grantedScopes,
        },
        ref.auth,
        { env, ...(waitUntil ? { waitUntil } : {}) },
      );
      if (surface === "staff" && !handlerContext.staff) {
        return forbidden(requiredScopes);
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
            executeView: runtime.executeView,
            invokeProcedure: runtime.invokeProcedure,
            media: mediaEnabled && runtime.media
              ? {
                  createUpload: runtime.media.createUpload,
                  commitUpload: runtime.media.commitUpload,
                  purposes: mediaPurposes,
                }
              : undefined,
          },
          [...runtime.schemasByName.values()],
          {
            surface,
            // A View belongs on surface S iff its declared surface
            // (default "public") matches — mirrors how procedures are
            // gated (#438). Without this, `surface: "staff"` Views leaked
            // into the public `/mcp` tools/list + tools/call.
            views: ref.manifests.filter(
              (m): m is ViewManifest =>
                m.kind === "View" && m.spec.surface === surface,
            ),
            procedures: collectMcpProcedures(runtime.triggers, runtime.proceduresByName, surface),
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

interface OAuthApiProps {
  readonly userId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

function readOAuthApiProps(value: unknown): OAuthApiProps | null {
  if (!value || typeof value !== "object") return null;
  const props = value as Record<string, unknown>;
  if (
    typeof props["userId"] !== "string" ||
    props["userId"].length === 0 ||
    typeof props["clientId"] !== "string" ||
    props["clientId"].length === 0 ||
    !Array.isArray(props["scopes"]) ||
    !props["scopes"].every((scope) => typeof scope === "string")
  ) return null;
  return {
    userId: props["userId"],
    clientId: props["clientId"],
    scopes: props["scopes"],
  };
}

function forbidden(requiredScopes: readonly string[]): Response {
  const scope = requiredScopes.join(" ");
  return new Response("forbidden", {
    status: 403,
    headers: {
      "www-authenticate": `Bearer realm="mcp", error="insufficient_scope", scope="${scope}"`,
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
  triggers: readonly TriggerManifest[],
  proceduresByName: ReadonlyMap<string, ProcedureManifest>,
  surface: "staff" | "public",
): readonly ProcedureManifest[] {
  const out: ProcedureManifest[] = [];
  for (const t of triggers) {
    if (t.spec.source.kind !== "mcp") continue;
    if (t.spec.source.surface !== surface) continue;
    const p = proceduresByName.get(t.spec.target.procedure);
    if (p) out.push(p);
  }
  return out;
}
