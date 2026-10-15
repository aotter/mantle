/** The Admin App is an ordinary contributor to the SDK's public MCP Apps hook. */
import { ContractError } from "@aotter/mantle/contracts";
import type { McpApps, McpAppRender, McpAppResource } from "@aotter/mantle/mcp";
export interface AdminMcpOptions {
    readonly catalogue: {
        readonly views: Readonly<Record<string, unknown>>;
        readonly actions: Readonly<Record<string, unknown>>;
    };
    readonly html: McpAppResource["html"];
    readonly uri?: string;
    readonly title?: string;
    readonly appOnly?: readonly string[];
    /** Passed through as `_meta.ui.domain`, for a host that serves each App from its own origin. */
    readonly domain?: string;
}
/** The catalogue as one caller sees it: only Views and actions its tools/list shows, so the HTML names no other tool. */
function visibleCatalogue({ views, actions }: AdminMcpOptions["catalogue"], tools: ReadonlySet<string>): AdminMcpOptions["catalogue"] {
    const view = (value: unknown) => value !== null && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions)
        ? { ...value, actions: (value as { actions: unknown[] }).actions.filter(name => typeof name === "string" && tools.has(name)) }
        : value;
    return {
        views: Object.fromEntries(Object.entries(views).filter(([name]) => tools.has(name)).map(([name, value]) => [name, view(value)])),
        actions: Object.fromEntries(Object.entries(actions).filter(([name]) => tools.has(name))),
    };
}
export function adminMcpApps(options: AdminMcpOptions): McpApps {
    const uri = options.uri ?? "ui://mantle-admin/admin";
    if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    const embed = (html: string, render: McpAppRender) => {
        const script = '<script type="application/json" id="mantle-catalog">' + JSON.stringify(visibleCatalogue(options.catalogue, render.tools)).replace(/</g, "\\u003c") + "</script>";
        return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, end => script + end) : script + html;
    };
    const html = options.html;
    return { resources: [{ uri, name: "mantle-admin-admin", title: options.title ?? "Admin", html: async (render: McpAppRender) => embed(typeof html === "string" ? html : await html(render), render), renders: Object.keys(options.catalogue.views), ...(options.appOnly ? { appOnly: options.appOnly } : {}), ...(options.domain !== undefined ? { domain: options.domain } : {}) }] };
}
