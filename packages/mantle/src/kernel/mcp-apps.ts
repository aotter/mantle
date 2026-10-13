import { ContractError } from "./contracts.js";
/** MCP Apps (ADR-0029 D7): UI resources served beside the tools that render in them. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

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
  /** Views only this App may call (`visibility: ["app"]`); a client without MCP Apps does not see them. A Procedure cannot be hidden from the model. */
  readonly appOnly?: readonly string[];
}

export interface McpApps {
  readonly resources: readonly McpAppResource[];
}

/** The resources of one endpoint's contributors; a contributor's `resources` may be a getter, so `mcp(...)` reads it once. */
export const resourcesOf = (apps: McpApps | readonly McpApps[]): McpApps => ({ resources: (Array.isArray(apps) ? apps : [apps]).flatMap(app => app.resources) });

/** Checked when `mcp(...)` is built; without a tool table (a request-bound one) only the configuration itself is checked, the tool links wait for the first request. */
export function linkApps(apps: McpApps | readonly McpApps[], tools?: ReadonlySet<string>, views?: ReadonlySet<string>) {
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
    // an App acts for the user without the model seeing the call, so only a read may be hidden from the model
    for (const tool of resource.appOnly ?? []) {
      if (views && !views.has(tool)) refuse(`App-only tool '${tool}' must be a View this endpoint serves.`);
      appOnly.add(tool);
    }
  }
  return { resources, renders, appOnly };
}

/** One endpoint's Apps bound to its tool table; `previous` is reused while the table's names are unchanged. */
export function linkSurface(apps: McpApps | readonly McpApps[], selected: readonly { name: string; page?: unknown }[], previous?: { key: string; links: ReturnType<typeof linkApps> }) {
  const key = JSON.stringify(selected.map(tool => tool.name).sort());
  return previous?.key === key ? previous : { key, links: linkApps(apps, new Set(selected.map(tool => tool.name)), new Set(selected.filter(tool => tool.page).map(tool => tool.name))) };
}
