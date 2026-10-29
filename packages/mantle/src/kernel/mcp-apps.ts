import { ContractError } from "./contracts.js";
/** MCP Apps (ADR-0029 D7): UI resources served beside the tools that render in them. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** What `resources/read` passes an HTML loader. */
export interface McpAppRender {
  /** The tools this caller's `tools/list` shows on the endpoint, so the HTML names none it cannot see. */
  readonly tools: ReadonlySet<string>;
  /** The request's environment as the handler received it: Worker bindings such as `ASSETS`, or whatever a Bun host passes. */
  readonly env: unknown;
  /** The `resources/read` request, for its origin. */
  readonly request: Request;
}

/** The CSP a resource asks its host for, as `_meta.ui.csp`. */
export type McpAppCsp = { readonly connectDomains?: readonly string[]; readonly resourceDomains?: readonly string[]; readonly frameDomains?: readonly string[]; readonly baseUriDomains?: readonly string[] };

/** What a loader may return beside a plain string: the HTML and a CSP known only when it is read. It is sent on `resources/read` and replaces the resource's static `csp` (lists are not merged). */
export interface McpAppPage {
  readonly html: string;
  readonly csp?: McpAppCsp;
}

/** One `ui://` resource. The HTML is a reusable asset and never carries caller data: that travels in tool results. */
export interface McpAppResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly html: string | ((render: McpAppRender) => string | McpAppPage | Promise<string | McpAppPage>);
  readonly csp?: McpAppCsp;
  readonly permissions?: { readonly camera?: Record<string, never>; readonly microphone?: Record<string, never>; readonly geolocation?: Record<string, never>; readonly clipboardWrite?: Record<string, never> };
  readonly prefersBorder?: boolean;
  /** `_meta.ui.domain`: the dedicated sandbox origin a host should serve this App from, in the form that host documents. */
  readonly domain?: string;
  /** Tool names whose results this resource renders. */
  readonly renders?: readonly string[];
  /** Views only this App may call (`visibility: ["app"]`); a client without MCP Apps does not see them. To hide a Procedure, give its tool `meta: { ui: { visibility: ["app"] } }`. */
  readonly appOnly?: readonly string[];
}

export interface McpApps {
  readonly resources: readonly McpAppResource[];
}

/** An application-owned contributor resolved after the endpoint's caller gate. */
export type McpAppsSource = McpApps | ((context: Pick<McpAppRender, "env" | "request">) => McpApps | Promise<McpApps>);

/** Flatten contributors; `mcp(...)` reads static resources getters once at construction. */
export const resourcesOf = (apps: McpApps | readonly McpApps[]): McpApps => ({ resources: (Array.isArray(apps) ? apps : [apps]).flatMap(app => app.resources) });

/** Static contributors are checked at construction; resolved factories are checked per request. A request-bound tool table defers tool-link checks until its first request. */
export function linkApps(apps: McpApps | readonly McpApps[], tools?: ReadonlyMap<string, Readonly<Record<string, any>> | undefined>, views?: ReadonlySet<string>) {
  const resources = resourcesOf(apps).resources as McpAppResource[];
  const uris = new Set<string>(), names = new Set<string>(), renders = new Map<string, string>(), appOnly = new Set<string>();
  const refuse = (message: string): never => { throw new ContractError("MCP_APP_CONFLICT", message, "mcp:apps", { status: 500 }); };
  for (const resource of resources) {
    if (!resource.uri.startsWith("ui://")) refuse(`MCP App resource '${resource.name}' must use a ui:// URI.`);
    if (uris.has(resource.uri)) refuse(`MCP App resource URI '${resource.uri}' is registered twice.`);
    if (names.has(resource.name)) refuse(`MCP App resource name '${resource.name}' is registered twice.`);
    uris.add(resource.uri); names.add(resource.name);
    for (const tool of [...resource.renders ?? [], ...resource.appOnly ?? []]) {
      if (tools && !tools.has(tool)) refuse(`MCP App resource '${resource.name}' names tool '${tool}', which this endpoint does not serve.`);
      if (renders.has(tool) && renders.get(tool) !== resource.uri) refuse(`Tool '${tool}' is claimed by two MCP App resources.`);
      renders.set(tool, resource.uri);
    }
    // appOnly stays for Views; a tool's own `meta.ui.visibility` may hide a Procedure (a listing hint, not authorization)
    for (const tool of resource.appOnly ?? []) {
      if (views && !views.has(tool)) refuse(`App-only tool '${tool}' must be a View this endpoint serves.`);
      appOnly.add(tool);
    }
  }
  // A tool's own `meta` merges with what its App links produce, and may not contradict them.
  for (const [tool, uri] of renders) {
    const meta = tools?.get(tool) ?? {}, ui = meta.ui ?? {};
    if ([ui.resourceUri, meta["ui/resourceUri"], meta["openai/outputTemplate"]].some(value => value && value !== uri) || appOnly.has(tool) && ui.visibility && `${ui.visibility}` !== "app") refuse(`Tool '${tool}' meta contradicts its MCP App links.`);
  }
  return { resources, renders, appOnly };
}

/** One endpoint's Apps bound to its tool table; `previous` is reused while the table's names are unchanged. */
export function linkSurface(apps: McpApps | readonly McpApps[], selected: readonly { name: string; page?: unknown; meta?: Readonly<Record<string, unknown>> }[], previous?: { key: string; links: ReturnType<typeof linkApps> }) {
  const key = JSON.stringify(selected.map(tool => [tool.name, !!tool.page, tool.meta] as const).sort(([a], [b]) => a.localeCompare(b)));
  return previous?.key === key ? previous : { key, links: linkApps(apps, new Map(selected.map(tool => [tool.name, tool.meta])), new Set(selected.filter(tool => tool.page).map(tool => tool.name))) };
}
