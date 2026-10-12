import type { McpApps, McpAppResource } from "./mcp-apps.js";
export interface AppLinks {
  readonly resources: readonly McpAppResource[];
  readonly rendersIn: ReadonlyMap<string, string>;
  readonly appOnly: ReadonlyMap<string, string>;
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
