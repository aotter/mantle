/** The Admin App is an ordinary contributor to the SDK's public MCP Apps hook. */
import { ContractError } from "@aotter/mantle/contracts";
import { declaredMeta } from "../app/declared-meta.js";
import type { McpApps, McpAppsSource, McpAppPage, McpAppRender, McpAppResource } from "@aotter/mantle/mcp";
/** An archived resources/read page, including its embedded catalogue; application-owned, never caller rows or credentials. */
export interface AdminMcpSnapshot extends McpAppPage {
    readonly uri: string;
    readonly domain?: string;
}
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
    /** Immutable cache identity. Omit for built assets: their HTML, catalogue and resource metadata determine it. A custom HTML function must supply its own build-specific URI. */
    readonly uri?: string;
    readonly title?: string;
    /** Views rendered by this App; all catalogue Views by default. Partition explicitly before registering another renderer. */
    readonly renders?: readonly string[];
    readonly appOnly?: readonly string[];
    /** Passed through as `_meta.ui.domain`, for a host that serves each App from its own origin. */
    readonly domain?: string;
    /** Previously deployed immutable pages. Keep these in source/artifact storage across clean builds; they claim no current renderer. */
    readonly previous?: readonly AdminMcpSnapshot[];
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
    const csp = declaredMeta<McpAppPage["csp"]>(html, "mantle-mcp-csp");
    return csp ? { html, csp } : { html };
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
export function adminMcpApps(options: AdminMcpOptions & { readonly uri: string }): McpApps;
export function adminMcpApps(options: AdminMcpOptions): McpAppsSource;
export function adminMcpApps(options: AdminMcpOptions): McpAppsSource {
    if (options.uri !== undefined && !/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(options.uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    const renders = options.renders ?? Object.keys(options.catalogue.views);
    for (const view of renders) if (!Object.hasOwn(options.catalogue.views, view))
        throw new ContractError("MCP_APP_CONFLICT", `Admin App renderer names unknown View '${view}'.`, "mcp/apps");
    const embed = (html: string, render: McpAppRender, catalogue = options.catalogue) => {
        const script = '<script type="application/json" id="mantle-catalog">' + JSON.stringify(visibleCatalogue(catalogue, render.tools)).replace(/</g, "\\u003c") + "</script>";
        // right after the opening <head>: the module script that follows may hold the text "</head>" in a string
        return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, start => start + script) : script + html;
    };
    const previous = (options.previous ?? []).map((snapshot, index): McpAppResource => {
        const script = /<script type="application\/json" id="mantle-catalog">([\s\S]*?)<\/script>/;
        const found = script.exec(snapshot.html);
        let catalogue: AdminMcpOptions["catalogue"] | undefined;
        try { catalogue = found ? JSON.parse(found[1]!) : undefined; } catch {}
        const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
        if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(snapshot.uri) || !catalogue || !object(catalogue.views) || !object(catalogue.actions))
            throw new ContractError("INPUT_VALIDATION_FAILED", "A retained Admin App needs its original ui://mantle-admin/… URI and embedded catalogue from resources/read.", "mcp/apps");
        const base = snapshot.html.replace(script, ""), archivedCatalogue = catalogue;
        return { uri: snapshot.uri, name: `mantle-admin-previous-${index}`, title: options.title ?? "Admin",
            ...(snapshot.domain !== undefined ? { domain: snapshot.domain } : {}),
            html: async render => ({ html: embed(base, render, archivedCatalogue), ...(snapshot.csp ? { csp: snapshot.csp } : {}) }) };
    });
    const contribute = (uri: string, html: McpAppResource["html"]): McpApps => ({ resources: [{ uri, name: "mantle-admin-admin", title: options.title ?? "Admin", html: async (render: McpAppRender) => {
        const loaded = typeof html === "string" ? html : await html(render), page = typeof loaded === "string" ? { html: loaded } : loaded;
        return { ...page, html: embed(page.html, render) };
    }, renders, ...(options.appOnly ? { appOnly: options.appOnly } : {}), ...(options.domain !== undefined ? { domain: options.domain } : {}) }, ...previous.filter(resource => resource.uri !== uri)] });
    const html = options.html ?? builtApp(options.file ?? "dist/client/admin/mcp-app.html");
    if (options.uri !== undefined) return contribute(options.uri, html);
    if (typeof options.html === "function")
        throw new ContractError("INPUT_VALIDATION_FAILED", "A custom Admin HTML loader must declare a build-specific uri; caller-dependent loader output is never cached.", "mcp/apps");

    const prepare = async (page: McpAppPage) => {
        // The base asset has no caller catalogue. A declaration change also changes the
        // identity even when the React/CSS build is byte-identical.
        const identity = JSON.stringify(["mantle-admin-app-v1", page.html, options.catalogue, page.csp ?? null,
            { title: options.title ?? "Admin", domain: options.domain ?? null, renders, appOnly: options.appOnly ?? [] }]);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
        const revision = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { page, uri: `ui://mantle-admin/admin/${revision}` };
    };
    // ASSETS is immutable for a Worker deployment. Keep only its raw asset and
    // identity, scoped to this contributor and binding; embed caller tools per read.
    const assets = new WeakMap<object, ReturnType<typeof prepare>>();
    let inline: ReturnType<typeof prepare> | undefined;
    return async context => {
        const binding = (context.env as { ASSETS?: object } | null | undefined)?.ASSETS;
        const load = async () => prepare(await builtApp(options.file ?? "dist/client/admin/mcp-app.html")({ ...context, tools: new Set() }));
        let prepared = typeof options.html === "string"
            ? inline ??= prepare(withCsp(options.html))
            : binding && assets.get(binding);
        if (!prepared) {
            prepared = load();
            if (binding) {
                assets.set(binding, prepared);
                void prepared.catch(() => { if (assets.get(binding) === prepared) assets.delete(binding); });
            }
        }
        // Bun rereads the file: a new build in the same process gets a new identity.
        const loaded = await prepared;
        return contribute(loaded.uri, () => loaded.page);
    };
}
