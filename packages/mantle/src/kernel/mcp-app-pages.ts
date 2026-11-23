/**
 * `@aotter/mantle/mcp/apps`: MCP Apps in normal form. A subpath of its own so that importing it costs a Worker's
 * startup nothing unless the application's own startup code does; the endpoint loads it on a request.
 */
import {
  resourcesOf,
  type McpAppRender,
  type McpAppResource,
  type McpAppsSource,
  type NormalMcpAppResource,
  type NormalMcpApps,
} from "./mcp-apps.js";
export type { NormalMcpAppResource, NormalMcpApps } from "./mcp-apps.js";

/** The normal form of an `html` input: a string or a loader's string result becomes a page. */
export const mcpAppPageLoader =
  (html: McpAppResource["html"]): NormalMcpAppResource["html"] =>
  async render => {
    const loaded = typeof html === "string" ? html : await html(render);
    return typeof loaded === "string" ? { html: loaded } : loaded;
  };

/**
 * Resolve App sources for one request into normal form. This is the one place that handles a function-or-object source,
 * string-or-loader HTML and a string-or-page result: the endpoint reads its Apps through it, and so does an application
 * that wraps a contributor (to observe a page being read, add a renderer or change a URI) and passes the result on.
 */
export async function resolveMcpApps(
  sources: McpAppsSource | readonly McpAppsSource[],
  context: Pick<McpAppRender, "env" | "request">,
): Promise<NormalMcpApps> {
  const list = (Array.isArray(sources) ? sources : [sources]) as readonly McpAppsSource[];
  const resolved = await Promise.all(list.map(source => (typeof source === "function" ? source(context) : source)));
  return {
    resources: resourcesOf(resolved).resources.map(resource => ({
      ...resource,
      html: mcpAppPageLoader(resource.html),
    })),
  };
}
