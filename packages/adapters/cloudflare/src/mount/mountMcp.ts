import {
  bindCapabilities,
  buildCapabilityCatalog,
  interactionReadTargets,
  projectCallableCapabilities,
  readJsonBody,
} from "@aotter/mantle-runtime";
import { createMantleMcpHandler, type MantleMcpApps, type MantleMcpHandler } from "@aotter/mantle-mcp";
import { DPOP_SIGNING_ALGORITHMS } from "better-auth/oauth2";
import type { MantleRuntimeRef } from "./bootRuntimeOnce.js";
import type { HandlerContext } from "@aotter/mantle-runtime";
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
  /** Scopes the authorization server can issue for this resource. A token
   *  missing a tool's declared scope is asked to step up only when every
   *  such scope is listed here; otherwise the call is a denied tool result.
   *  Defaults to `requiredScopes`, which is all conventional Auth grants. */
  readonly grantableScopes?: readonly string[];
  /** MCP Apps UI resources for this surface only (ADR-0029 D7). A staff
   *  resource passed to the staff handler is never readable on public. */
  readonly apps?: MantleMcpApps;
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
  const grantableScopes = options.grantableScopes ?? requiredScopes;
  // Denied requests never reach the handler, so their audit events resolve
  // the correlation argument from the same catalog here.
  const auditCatalog = buildCapabilityCatalog(
    Object.values(ref.plan.schemas).map(({ manifest }) => manifest),
    { surface, callables: projectCallableCapabilities(ref.plan, { surface }), readTargets: interactionReadTargets(ref.plan, surface) },
  );
  const auditOperationId = (tool: string, args: Readonly<Record<string, unknown>>): string | null => {
    const value = args[auditCatalog.get(tool)?.operationIdArgument ?? "operationId"];
    return typeof value === "string" ? value : null;
  };
  const resourceMetadataUrl = protectedResourceMetadataUrl(resource);
  // Key the cached handler to the runtime identity. Without this, if
  // `ref.get()` rejects + resets and the next call returns a new runtime
  // instance, the cached handler would silently keep pointing at the
  // pre-reset use-cases. A WeakMap also lets the GC reclaim it.
  const handlerCache = new WeakMap<object, {
    readonly configKey: string;
    readonly handler: MantleMcpHandler;
  }>();

  return {
    async fetch(request, env, ctx) {
      const waitUntil = typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
      // One gate for every transport (#977): consumer credential, OAuth bearer
      // or cookie session, in that order, then the surface's single rule.
      // `public` admits anonymous callers and leaves enforcement to each
      // tool's `requires`; `staff` needs `ctx.staff`. Denials keep the OAuth
      // challenge so a client without a token knows where to get one.
      // Credential resolvers and fresh roles may use the same canonical database.
      const runtime = await ref.get();
      const gate = await gateCaller(request, {
        auth: ref.auth,
        credentialResolver: ref.credentialResolver,
        jwtBearer: { audience: resource, scopes: requiredScopes },
        env,
        ...(waitUntil ? { waitUntil } : {}),
        phase: diagnosticPhase,
        surface,
      });
      // Denials are audit events too: a probing token never reaches the
      // handler, so the trail is written here, with the same event shape.
      const denied = (denial: { readonly status: 401 | 403; readonly reason: string }, ctx?: HandlerContext) => {
        auditDenial(ref.audit, request, surface, denial.reason, ctx, waitUntil, auditOperationId);
        return oauthDenied(resource, requiredScopes, denial);
      };
      if (gate.kind === "deny") return denied(gate, gate.context);
      const handlerContext = gate.context;
      // The scope floor applies to every presented credential, not only the
      // bearer path: a host PAT minted for a narrow integration must not reach
      // the handler without `mcp`. A cookie session carries no scopes and is
      // the same browser identity Admin trusts, so it is exempt; anonymous
      // callers present nothing to check and are governed by each tool.
      const credential = handlerContext.auth;
      if (credential && credential.credential !== "session"
        && requiredScopes.some((scope) => !credential.scopes.includes(scope))) {
        return denied({ status: 403, reason: "insufficient-scope" }, handlerContext);
      }
      // Media tools require BOTH a storage adapter AND a declared
      // `media.purposes` taxonomy (#262). Empty purposes →
      // create_media_upload would always fail-closed, so don't surface
      // the tools in tools/list at all. Read this before consulting the
      // handler cache so operator edits to site_config update the
      // MCP catalog without a redeploy/runtime reset.
      const site = await diagnosticPhase("catalog", async () => {
        if (ref.mcpCatalogSiteConfig) return ref.mcpCatalogSiteConfig.loadCatalogSite(runtime);
        const record = requestDiagnosticContext.getStore();
        if (record) record.catalog.source = "binding-absent";
        return runtime.siteConfig.load();
      });
      const stopBuild = beginDiagnosticPhase("dispatcherBuild");
      let selected: MantleMcpHandler;
      try {
        const mediaPurposes = runtime.media ? site.media.purposes : [];
        // Serialise the whole policy set as the cache key — name + required
        // mimes + per-mime maxBytes all participate. Operator edits to any
        // of these rebuild the handler when the discovery snapshot changes.
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
        let cached = handlerCache.get(runtime);
        if (!cached || cached.configKey !== configKey) {
          const handler = createMantleMcpHandler(
            bindCapabilities(runtime, ref.plan, { surface, mediaPurposes }),
            {
              serverInfo,
              ...(ref.audit ? { audit: ref.audit } : {}),
              // Anonymous calls to identity-requiring tools get the same
              // challenge as the gate's own denials (#977); a token that lacks
              // a grantable declared scope gets the SDK's step-up challenge.
              unauthenticated: () => oauthDenied(resource, requiredScopes, { status: 401, reason: "unauthenticated" }),
              oauth: { scopes: requiredScopes, grantable: grantableScopes },
              ...(options.apps ? { apps: options.apps } : {}),
              resourceMetadataUrl,
            },
          );
          // Release the replaced handler's open listen streams.
          if (cached) void cached.handler.close().catch(() => {});
          cached = { configKey, handler };
          handlerCache.set(runtime, cached);
        }
        selected = cached.handler;
      } finally { stopBuild(); }
      return diagnosticPhase("dispatch", () => selected.fetch(request, handlerContext));
    },
  };
}

function challengeHeaders(
  resource: string,
  requiredScopes: readonly string[],
  denied: { readonly status: 401 | 403; readonly reason?: string },
): Record<string, string> {
  const scope = requiredScopes.join(" ");
  const metadata = protectedResourceMetadataUrl(resource);
  // RFC 6750 §3.1: omit `error` when no token was presented or when the
  // denial is not about the token (a guard or tenancy rule said no).
  const tokenError = denied.reason === "unauthenticated" || denied.reason === "target-denied"
    ? ""
    : `, error="${denied.status === 403 ? "insufficient_scope" : "invalid_token"}"`;
  const challenge = denied.reason === "invalid-dpop-proof"
    ? `DPoP error="invalid_dpop_proof", algs="${DPOP_SIGNING_ALGORITHMS.join(" ")}"`
    : `Bearer realm="mcp"${tokenError}, scope="${scope}", resource_metadata="${metadata}"`;
  return {
    "www-authenticate": challenge,
    "access-control-expose-headers": "WWW-Authenticate",
  };
}

/** `tool` recorded for a denied request whose body could not be read within
 *  the JSON limit or was not JSON. */
export const AUDIT_UNREADABLE_TOOL = "(unreadable)";

/** Record a gate denial for `tools/call` only; discovery methods carry no
 *  tool and are not audited. `reason` is normalised to the handler's
 *  UPPER_SNAKE outcome vocabulary (`INSUFFICIENT_ROLE`, `INVALID_TOKEN`…). */
function auditDenial(
  audit: MantleRuntimeRef["audit"],
  request: Request,
  surface: "public" | "staff",
  reason: string,
  ctx: HandlerContext | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  auditOperationId: (tool: string, args: Readonly<Record<string, unknown>>) => string | null,
): void {
  if (!audit) return;
  const at = Date.now();
  // The same 1 MiB bound the handler uses: an unauthenticated
  // caller must not be able to make the Worker buffer an unbounded body just
  // because auditing is on. A body that is oversized or not JSON is still a
  // denied request and is recorded with `tool: AUDIT_UNREADABLE_TOOL`, so
  // padding the body cannot hide a credential probe from the trail.
  const unreadable = [{ tool: AUDIT_UNREADABLE_TOOL, operationId: null }];
  const settled = readJsonBody(request.clone())
    .then((body: unknown) => {
      if (!body || typeof body !== "object") return unreadable;
      // A 2025-era batch is denied as a whole; each of its calls is recorded.
      return (Array.isArray(body) ? body : [body]).flatMap((item: unknown) => {
        const message = item as {
          method?: unknown;
          params?: { name?: unknown; arguments?: Record<string, unknown> };
        } | null;
        if (!message || typeof message !== "object") return unreadable;
        if (message.method !== "tools/call" || typeof message.params?.name !== "string") return [];
        return [{
          tool: message.params.name,
          operationId: auditOperationId(message.params.name, message.params.arguments ?? {}),
        }];
      });
    }, () => unreadable)
    .then((calls) => Promise.all(calls.map((call) => audit.record({
      at,
      surface,
      callerId: ctx?.user?.id ?? null,
      clientId: ctx?.auth?.clientId ?? null,
      credential: ctx?.auth?.credential ?? null,
      tool: call.tool,
      operationId: call.operationId,
      outcome: reason.toUpperCase().replaceAll("-", "_"),
      durationMs: Date.now() - at,
    }))))
    .catch((error: unknown) => {
      console.error("[mountMcp] audit sink failed", error);
    });
  waitUntil?.(settled);
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

/** RFC 9728 metadata location for the protected resource. */
function protectedResourceMetadataUrl(resource: string): string {
  const resourceUrl = new URL(resource);
  const resourcePath = resourceUrl.pathname.replace(/\/$/u, "");
  return new URL(`/.well-known/oauth-protected-resource${resourcePath}`, resourceUrl.origin).href;
}
