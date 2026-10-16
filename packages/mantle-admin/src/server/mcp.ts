/** The Admin App is an ordinary contributor to the SDK's public MCP Apps hook. */
import { ContractError } from "@aotter/mantle/contracts";
import type { McpApps, McpAppPage, McpAppRender, McpAppResource } from "@aotter/mantle/mcp";
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
/** The CSP `defineAdmin({ mcp: { csp } })` declared, which `mantle bundle` wrote into the file; sent as `_meta.ui.csp` on `resources/read`. */
const withCsp = (html: string): McpAppPage => {
    const declared = /<meta name="mantle-mcp-csp" content='([^']*)'>/.exec(html)?.[1];
    return declared ? { html, csp: JSON.parse(declared) } : { html };
};
/** The built App: a Worker's `ASSETS` binding (the name `wrangler.jsonc`'s `assets.binding` must have, else pass `html`) serves it at `/admin/mcp-app.html`; Bun reads it from disk. */
const builtApp = (file: string) => async ({ env, request }: McpAppRender): Promise<McpAppPage> => {
    const assets = (env as { readonly ASSETS?: { fetch(request: Request): Promise<Response> } } | null | undefined)?.ASSETS;
    if (assets) {
        const url = new URL("/admin/mcp-app.html", request.url);
        let response = await assets.fetch(new Request(url, { redirect: "manual" }));
        // the default `html_handling` answers a `.html` path with a redirect to the extensionless one: follow one, on this origin
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (location && new URL(location, url).origin === url.origin) response = await assets.fetch(new Request(new URL(location, url), { redirect: "manual" }));
        if (!response.ok)
            throw new Error(`The Admin MCP App is not in the assets (/admin/mcp-app.html answered ${response.status}); run \`mantle bundle\`.`);
        return withCsp(await response.text());
    }
    const bun = (globalThis as { Bun?: { file(path: string): { text(): Promise<string> } } }).Bun;
    if (bun)
        return withCsp(await bun.file(file).text());
    throw new Error("The Admin MCP App has no loader here: bind ASSETS, run on Bun, or pass `html`.");
};
export function adminMcpApps(options: AdminMcpOptions): McpApps {
    const uri = options.uri ?? "ui://mantle-admin/admin";
    if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    const embed = (html: string, render: McpAppRender) => {
        const script = '<script type="application/json" id="mantle-catalog">' + JSON.stringify(visibleCatalogue(options.catalogue, render.tools)).replace(/</g, "\\u003c") + "</script>";
        // right after the opening <head>: the module script that follows may hold the text "</head>" in a string
        return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, start => start + script) : script + html;
    };
    const html = options.html ?? builtApp(options.file ?? "dist/client/admin/mcp-app.html");
    return { resources: [{ uri, name: "mantle-admin-admin", title: options.title ?? "Admin", html: async (render: McpAppRender) => {
        const loaded = typeof html === "string" ? html : await html(render), page = typeof loaded === "string" ? { html: loaded } : loaded;
        return { ...page, html: embed(page.html, render) };
    }, renders: Object.keys(options.catalogue.views), ...(options.appOnly ? { appOnly: options.appOnly } : {}), ...(options.domain !== undefined ? { domain: options.domain } : {}) }] };
}
