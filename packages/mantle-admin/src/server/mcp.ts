/** The Admin App is an ordinary contributor to the SDK's public MCP Apps hook. */
import { ContractError } from "@aotter/mantle/contracts";
import type { McpApps, McpAppRender, McpAppResource } from "@aotter/mantle/mcp";
export interface AdminMcpOptions {
    readonly catalogue: {
        readonly views: Readonly<Record<string, unknown>>;
        readonly actions: Readonly<Record<string, unknown>>;
    };
    /**
     * The App's HTML. Without it, the file `mantle bundle` built into `<assets>/admin/mcp-app.html`: read through the Worker's
     * `env.ASSETS` binding or, on Bun, from `file`. Pass a loader to serve it from elsewhere.
     */
    readonly html?: McpAppResource["html"];
    /** Where Bun reads the built App from when `html` is not given; `dist/client/admin/mcp-app.html` by default. */
    readonly file?: string;
    readonly uri?: string;
    readonly title?: string;
    readonly appOnly?: readonly string[];
    /** Passed through as `_meta.ui.csp`: the same object as `defineAdmin({ mcp: { csp } })`, which `mantle bundle` checked the App against. */
    readonly csp?: McpAppResource["csp"];
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
/** The built App: a Worker's assets binding serves it at `/admin/mcp-app.html`; Bun reads it from disk. */
const builtApp = (file: string) => async ({ env, request }: McpAppRender): Promise<string> => {
    const assets = (env as { readonly ASSETS?: { fetch(request: Request): Promise<Response> } } | null | undefined)?.ASSETS;
    if (assets) {
        const response = await assets.fetch(new Request(new URL("/admin/mcp-app.html", request.url)));
        if (!response.ok)
            throw new Error(`The Admin MCP App is not in the assets (/admin/mcp-app.html answered ${response.status}); run \`mantle bundle\`.`);
        return response.text();
    }
    const bun = (globalThis as { Bun?: { file(path: string): { text(): Promise<string> } } }).Bun;
    if (bun)
        return bun.file(file).text();
    throw new Error("The Admin MCP App has no loader here: bind ASSETS, run on Bun, or pass `html`.");
};
export function adminMcpApps(options: AdminMcpOptions): McpApps {
    const uri = options.uri ?? "ui://mantle-admin/admin";
    if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    const embed = (html: string, render: McpAppRender) => {
        const script = '<script type="application/json" id="mantle-catalog">' + JSON.stringify(visibleCatalogue(options.catalogue, render.tools)).replace(/</g, "\\u003c") + "</script>";
        return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, end => script + end) : script + html;
    };
    const html = options.html ?? builtApp(options.file ?? "dist/client/admin/mcp-app.html");
    return { resources: [{ uri, name: "mantle-admin-admin", title: options.title ?? "Admin", html: async (render: McpAppRender) => embed(typeof html === "string" ? html : await html(render), render), renders: Object.keys(options.catalogue.views), ...(options.appOnly ? { appOnly: options.appOnly } : {}), ...(options.csp ? { csp: options.csp } : {}), ...(options.domain !== undefined ? { domain: options.domain } : {}) }] };
}
