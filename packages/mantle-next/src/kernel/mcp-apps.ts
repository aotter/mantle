export { linkApps, type AppLinks } from "./mcp-app-links.js";
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

export const appHtml = async (r: McpAppResource) => (typeof r.html === "string" ? r.html : await r.html());

export function appMeta(r: McpAppResource): { ui: Record<string, unknown> } | undefined {
  const ui = { ...(r.csp ? { csp: r.csp } : {}), ...(r.permissions ? { permissions: r.permissions } : {}), ...(r.prefersBorder !== undefined ? { prefersBorder: r.prefersBorder } : {}) };
  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

/** Embed static generated catalogue data; never a RuntimePlan or caller data. */
export function planApp(catalog: { readonly views: Readonly<Record<string, unknown>>; readonly actions: Readonly<Record<string, unknown>> }, options: { readonly surface: "public" | "staff"; readonly html: McpAppResource["html"]; readonly uri?: string; readonly title?: string }): McpAppResource {
  const script = `<script type="application/json" id="mantle-catalog">${JSON.stringify(catalog).replace(/</g, "\\u003c")}</script>`;
  const html = options.html, embed = (html: string) => html.includes("</head>") ? html.replace("</head>", () => `${script}</head>`) : script + html;
  return { uri: options.uri ?? `ui://mantle/${options.surface}`, name: `mantle-${options.surface}`, title: options.title ?? "Mantle", description: "A Mantle View's rows, and the operations that act on one row.", html: typeof html === "string" ? embed(html) : async () => embed(await html()), renders: Object.keys(catalog.views) };
}
