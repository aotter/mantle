/** MCP Apps (ADR-0029 D7): UI resources served beside the tools that render in them. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

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
  for (const m of Array.isArray(message) ? message : [message]) {
    if (!isRecord(m) || !isRecord(m.params)) continue;
    const meta = m.params._meta;
    const declared = isRecord(meta) && isRecord(meta[CLIENT_CAPABILITIES_META_KEY]) ? meta[CLIENT_CAPABILITIES_META_KEY] : m.method === "initialize" && isRecord(m.params.capabilities) ? m.params.capabilities : undefined;
    if (!declared) continue;
    const extensions = declared.extensions, ui = isRecord(extensions) ? extensions["io.modelcontextprotocol/ui"] : undefined;
    return isRecord(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(RESOURCE_MIME_TYPE) ? "supported" : "unsupported";
  }
  return "unknown";
}

/** Checked once when the surface is built: a bad configuration fails at construction, not on the first request. */
export function linkApps(apps: McpApps | undefined, tools: ReadonlySet<string>, views: ReadonlySet<string>): AppLinks {
  const rendersIn = new Map<string, string>();
  const appOnly = new Map<string, string>();
  const uris = new Set<string>();
  for (const r of apps?.resources ?? []) {
    if (!r.uri.startsWith("ui://")) throw new TypeError(`MCP App resource '${r.name}' must use a ui:// URI.`);
    if (uris.has(r.uri)) throw new TypeError(`MCP App resource URI '${r.uri}' is registered twice.`);
    uris.add(r.uri);
    for (const [names, map] of [[r.renders ?? [], rendersIn], [r.appOnly ?? [], appOnly]] as const) for (const t of names) {
      if (map === appOnly ? !views.has(t) : !tools.has(t)) throw new TypeError(map === appOnly ? `App-only tool '${t}' must be a View this surface serves.` : `MCP App resource '${r.name}' renders '${t}', which this surface does not serve.`);
      const other = rendersIn.get(t) ?? appOnly.get(t);
      if (other && other !== r.uri) throw new TypeError(`Tool '${t}' links to both '${other}' and '${r.uri}'.`);
      map.set(t, r.uri);
    }
  }
  return { resources: apps?.resources ?? [], rendersIn, appOnly };
}

export const appHtml = async (r: McpAppResource) => (typeof r.html === "string" ? r.html : await r.html());

export function appMeta(r: McpAppResource): { ui: Record<string, unknown> } | undefined {
  const ui = { ...(r.csp ? { csp: r.csp } : {}), ...(r.permissions ? { permissions: r.permissions } : {}), ...(r.prefersBorder !== undefined ? { prefersBorder: r.prefersBorder } : {}) };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

/** Embed static generated catalogue data; never a RuntimePlan or caller data. */
export function planApp(catalog: { readonly views: Readonly<Record<string, unknown>>; readonly actions: Readonly<Record<string, unknown>> }, options: { readonly surface: "public" | "staff"; readonly html: string; readonly uri?: string; readonly title?: string }): McpAppResource {
  const script = `<script type="application/json" id="mantle-catalog">${JSON.stringify(catalog).replace(/</g, "\\u003c")}</script>`;
  return { uri: options.uri ?? `ui://mantle/${options.surface}`, name: `mantle-${options.surface}`, title: options.title ?? "Mantle", description: "A Mantle View's rows, and the operations that act on one row.", html: options.html.includes("</head>") ? options.html.replace("</head>", () => `${script}</head>`) : script + options.html, renders: Object.keys(catalog.views) };
}
