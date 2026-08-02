import { McpJsonRpcDispatcher } from "@aotter/mantle-runtime";
import type {
  ProcedureManifest,
  StaffRole,
  TriggerManifest,
  ViewManifest,
} from "@aotter/mantle-spec";
import { STAFF_ROLE_SET } from "../auth/createAuth.js";
import type { OAuthApiProps } from "../oauth/mountOAuth.js";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";

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
 * The OAuthProvider lib verifies the bearer token, decrypts grant
 * props, and sets `ctx.props` BEFORE calling this handler. We read
 * immutable grant props and re-read the caller's mutable staff role
 * from D1 on every invocation.
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
    readonly mediaPurposesKey: string;
    readonly dispatcher: McpJsonRpcDispatcher;
  }>();

  return {
    async fetch(request, env, ctx) {
      const props = (ctx as unknown as { props?: OAuthApiProps }).props;
      if (!props?.userId) return forbidden(requiredScopes);
      const grantedScopes = props.scopes?.length ? props.scopes : ["mcp"];
      if (requiredScopes.some((scope) => !grantedScopes.includes(scope))) {
        return forbidden(requiredScopes);
      }
      const role = await ref.auth.getUserRole(props.userId);
      if (surface === "staff" && (!role || !STAFF_ROLE_SET.has(role))) {
        return forbidden(requiredScopes);
      }
      const runtime = await ref.get();
      // Media tools require BOTH a storage adapter AND a declared
      // `media.purposes` taxonomy (#262). Empty purposes →
      // create_media_upload would always fail-closed, so don't surface
      // the tools in tools/list at all. Read this before consulting the
      // dispatcher cache so operator edits to site_config update the
      // MCP catalog without a redeploy/runtime reset.
      const mediaPurposes = runtime.media
        ? await runtime.siteConfig.readMediaPurposes()
        : [];
      // Serialise the whole policy set as the cache key — name + required
      // mimes + per-mime maxBytes all participate. Operator edits to any
      // of these (admin Settings → media taxonomy) rebuild the dispatcher
      // so tools/list reflects the latest contract without a redeploy.
      const mediaPurposesKey = JSON.stringify(mediaPurposes);
      let cached = dispatcherCache.get(runtime);
      if (!cached || cached.mediaPurposesKey !== mediaPurposesKey) {
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
                m.kind === "View" && (m.spec.surface ?? "public") === surface,
            ),
            procedures: collectMcpProcedures(runtime.triggers, runtime.proceduresByName, surface),
          },
        );
        cached = { mediaPurposesKey, dispatcher };
        dispatcherCache.set(runtime, cached);
      }
      const waitUntil = typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
      return cached.dispatcher.dispatch(
        request,
        {
          userId: props.userId,
          staff: role && STAFF_ROLE_SET.has(role)
            ? { userId: props.userId, role: role as StaffRole }
            : null,
          clientId: props.clientId ?? null,
          credentialId: null,
          scopes: grantedScopes,
        },
        { env, ...(waitUntil ? { waitUntil } : {}) },
      );
    },
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
