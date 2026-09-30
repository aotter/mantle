/** MCP Apps (ADR-0029 D7): UI resources served beside the tools that render in them. */
import { CLIENT_CAPABILITIES_META_KEY, type ClientCapabilities } from "@modelcontextprotocol/server";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

/** One `ui://` resource. The HTML is a reusable asset and never carries caller data: that travels in tool results. */
export interface McpAppResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly html: string | (() => string | Promise<string>);
  readonly csp?: { readonly connectDomains?: readonly string[]; readonly resourceDomains?: readonly string[]; readonly frameDomains?: readonly string[]; readonly baseUriDomains?: readonly string[] };
  readonly permissions?: { readonly camera?: Record<string, never>; readonly microphone?: Record<string, never>; readonly geolocation?: Record<string, never>; readonly clipboardWrite?: Record<string, never> };
  readonly prefersBorder?: boolean;
  /** Tool names whose results this resource renders. */
  readonly renders?: readonly string[];
  /** View tools only this App may call (`visibility: ["app"]`); a client without MCP Apps does not see them. */
  readonly appOnly?: readonly string[];
}

export interface McpApps {
  readonly resources: readonly McpAppResource[];
}

export interface AppLinks {
  readonly resources: readonly McpAppResource[];
  readonly rendersIn: ReadonlyMap<string, string>;
  readonly appOnly: ReadonlyMap<string, string>;
}

/** Whether the request's client renders MCP Apps; a stateless 2025-era request after `initialize` carries no capabilities: `unknown`. */
export type ClientUiSupport = "supported" | "unsupported" | "unknown";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function clientUiSupport(message: unknown): ClientUiSupport {
  const declared = (Array.isArray(message) ? message : [message]).map((m): ClientCapabilities | undefined => {
    if (!isRecord(m) || !isRecord(m["params"])) return undefined;
    const meta = m["params"]["_meta"];
    if (isRecord(meta) && isRecord(meta[CLIENT_CAPABILITIES_META_KEY])) return meta[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities;
    return m["method"] === "initialize" && isRecord(m["params"]["capabilities"]) ? (m["params"]["capabilities"] as ClientCapabilities) : undefined;
  }).find((c) => c !== undefined);
  if (declared === undefined) return "unknown";
  return getUiCapability(declared)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ? "supported" : "unsupported";
}

/** Checked once when the surface is built: a bad configuration fails at construction, not on the first request. */
export function linkApps(apps: McpApps | undefined, tools: ReadonlySet<string>, views: ReadonlySet<string>): AppLinks {
  const rendersIn = new Map<string, string>();
  const appOnly = new Map<string, string>();
  const linked = new Map<string, string>();
  const uris = new Set<string>();
  const link = (tool: string, uri: string) => {
    const other = linked.get(tool);
    if (other && other !== uri) throw new TypeError(`Tool '${tool}' links to both '${other}' and '${uri}'.`);
    linked.set(tool, uri);
  };
  for (const r of apps?.resources ?? []) {
    if (!r.uri.startsWith("ui://")) throw new TypeError(`MCP App resource '${r.name}' must use a ui:// URI.`);
    if (uris.has(r.uri)) throw new TypeError(`MCP App resource URI '${r.uri}' is registered twice.`);
    uris.add(r.uri);
    for (const t of r.renders ?? []) {
      if (!tools.has(t)) throw new TypeError(`MCP App resource '${r.name}' renders '${t}', which this surface does not serve.`);
      link(t, r.uri);
      rendersIn.set(t, r.uri);
    }
    for (const t of r.appOnly ?? []) {
      // an App acts for the user without the model seeing the call, so only a read may be hidden from the model
      if (!views.has(t)) throw new TypeError(`App-only tool '${t}' must be a View this surface serves.`);
      link(t, r.uri);
      appOnly.set(t, r.uri);
    }
  }
  return { resources: apps?.resources ?? [], rendersIn, appOnly };
}

export const appHtml = async (r: McpAppResource) => (typeof r.html === "string" ? r.html : await r.html());

export function appMeta(r: McpAppResource): { ui: Record<string, unknown> } | undefined {
  const ui = { ...(r.csp ? { csp: r.csp } : {}), ...(r.permissions ? { permissions: r.permissions } : {}), ...(r.prefersBorder !== undefined ? { prefersBorder: r.prefersBorder } : {}) };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}
