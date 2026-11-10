/** The Admin App is an ordinary contributor to the SDK's public MCP Apps hook. */
import { ContractError } from "@aotter/mantle/contracts";
import { declaredMeta } from "../app/declared-meta.js";
import type { McpAppPage, McpAppRender, McpAppResource, NormalMcpAppResource, NormalMcpApps } from "@aotter/mantle/mcp";
import type { MediaStorage } from "@aotter/mantle/site";
/** An archived resources/read page, including its embedded catalogue; application-owned, never caller rows or credentials. */
export interface AdminMcpSnapshot extends McpAppPage {
    readonly uri: string;
    readonly domain?: string;
    readonly title?: string;
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
    /**
     * An explicit resource URI. Without it, tools link the fixed `ui://mantle-admin/admin`, which hosts that prefetch and
     * cache the template keep across deploys, and the current build also answers at its content-hash URI for
     * conversations that hold one. Change it only for an App that saved conversations must not load, e.g.
     * `ui://mantle-admin/admin/v2`, or to scope the App per site for a host that re-serves several sites' Apps, e.g.
     * `ui://mantle-admin/<site>/admin`. The given URI is then the only one: the resource and every tool it renders link
     * it, and no content-hash alias is served (`previous` keeps older URIs answering).
     */
    readonly uri?: string;
    readonly title?: string;
    /** Views rendered by this App; all catalogue Views by default. Partition explicitly before registering another renderer. */
    readonly renders?: readonly string[];
    /**
     * Other tools of this endpoint whose results this App renders: Procedures, or the application's own tools. The App
     * shows the page declared for the tool (`pages[].mcp`), or the result's rows when it has any. The endpoint refuses
     * a name it does not serve.
     */
    readonly tools?: readonly string[];
    readonly appOnly?: readonly string[];
    /** Passed through as `_meta.ui.domain`, for a host that serves each App from its own origin. */
    readonly domain?: string;
    /** Previously deployed pages, kept so conversations that hold their URIs still render; they claim no current renderer. */
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
/** A contributor resolved per request, after the endpoint's caller gate; its resources are in normal form. */
export type AdminMcpAppsLoader = (context: Pick<McpAppRender, "env" | "request">) => Promise<NormalMcpApps>;
/**
 * The Admin App as an MCP Apps contributor. Every resource it returns is in normal form: `html` is an async loader that
 * resolves to a page. With an explicit `uri` the contributor is static; without one it usually resolves per request, so
 * the build's content-hash URI can be read from the deployed asset. To wrap what it returns without telling the two
 * apart, resolve it with `resolveMcpApps` from `@aotter/mantle/mcp/apps`.
 */
export function adminMcpApps(options: AdminMcpOptions & { readonly uri: string }): NormalMcpApps;
export function adminMcpApps(options: AdminMcpOptions): NormalMcpApps | AdminMcpAppsLoader;
export function adminMcpApps(options: AdminMcpOptions): NormalMcpApps | AdminMcpAppsLoader {
    if (options.uri !== undefined && !/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(options.uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    const views = options.renders ?? Object.keys(options.catalogue.views);
    for (const view of views) if (!Object.hasOwn(options.catalogue.views, view))
        throw new ContractError("MCP_APP_CONFLICT", `Admin App renderer names unknown View '${view}'. Name a Procedure or your own tool in \`tools\`.`, "mcp/apps");
    const renders = options.tools?.length ? [...new Set([...views, ...options.tools])] : views;
    const embed = (html: string, render: McpAppRender, catalogue = options.catalogue) => {
        const script = '<script type="application/json" id="mantle-catalog">' + JSON.stringify(visibleCatalogue(catalogue, render.tools)).replace(/</g, "\\u003c") + "</script>";
        // right after the opening <head>: the module script that follows may hold the text "</head>" in a string
        return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, start => start + script) : script + html;
    };
    const previousUris = new Set<string>();
    const previous = (options.previous ?? []).map((snapshot, index): NormalMcpAppResource => {
        const script = /<script type="application\/json" id="mantle-catalog">([\s\S]*?)<\/script>/;
        const found = script.exec(snapshot.html);
        let catalogue: AdminMcpOptions["catalogue"] | undefined;
        try { catalogue = found ? JSON.parse(found[1]!) : undefined; } catch {}
        const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
        if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(snapshot.uri) || !catalogue || !object(catalogue.views) || !object(catalogue.actions))
            throw new ContractError("INPUT_VALIDATION_FAILED", "A retained Admin App needs its original ui://mantle-admin/… URI and embedded catalogue from resources/read.", "mcp/apps");
        if (previousUris.has(snapshot.uri))
            throw new ContractError("MCP_APP_CONFLICT", `MCP App resource URI '${snapshot.uri}' is registered twice.`, "mcp/apps");
        previousUris.add(snapshot.uri);
        const base = snapshot.html.replace(script, ""), archivedCatalogue = catalogue;
        return { uri: snapshot.uri, name: `mantle-admin-previous-${index}`, title: snapshot.title ?? "Admin",
            ...(snapshot.domain !== undefined ? { domain: snapshot.domain } : {}),
            html: async render => ({ html: embed(base, render, archivedCatalogue), ...(snapshot.csp ? { csp: snapshot.csp } : {}) }) };
    });
    // `alias`: the current build also answers at its content-hash URI, as a page that claims no renderer
    const contribute = (uri: string, html: McpAppResource["html"], alias?: string): NormalMcpApps => {
        // Core's normaliser, loaded on `resources/read` only: a string or a loader, a string or a page.
        const page = async (render: McpAppRender) => {
            const loaded = await (await import("@aotter/mantle/mcp/apps")).mcpAppPageLoader(html)(render);
            return { ...loaded, html: embed(loaded.html, render) };
        };
        const domain = options.domain !== undefined ? { domain: options.domain } : {};
        const title = options.title ?? "Admin";
        return { resources: [
            { uri, name: "mantle-admin-admin", title, html: page, renders, ...(options.appOnly ? { appOnly: options.appOnly } : {}), ...domain },
            ...(alias !== undefined && alias !== uri ? [{ uri: alias, name: "mantle-admin-admin-revision", title, html: page, ...domain }] : []),
            ...previous.filter(resource => resource.uri !== uri && resource.uri !== alias),
        ] };
    };
    const html = options.html ?? builtApp(options.file ?? "dist/client/admin/mcp-app.html");
    if (options.uri !== undefined) return contribute(options.uri, html);
    // a caller-dependent loader has no build identity to hash: the fixed URI only
    if (typeof options.html === "function") return contribute(FIXED_URI, html);

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
        return contribute(FIXED_URI, () => loaded.page, loaded.uri);
    };
}
/** The default Admin App URI: stable across deploys, as hosts that prefetch and cache UI templates expect (#1934). */
const FIXED_URI = "ui://mantle-admin/admin";

export interface MediaUploadCardOptions<Env = never> {
    /**
     * The `media` option the application passes generated `mcp(...)`. Its storage's `uploadOrigin` (the origin its upload
     * URLs PUT to) is the card's CSP `connectDomains`, sent on `resources/read`.
     */
    readonly media: (env: Env) => Pick<MediaStorage, "uploadOrigin">;
    /** `ui://mantle-admin/upload` by default. A host serving several servers' cards gives each its own. */
    readonly uri?: string;
    /**
     * The tool the card renders and calls, `upload_media` by default: a host that re-serves several servers' media under
     * one endpoint names its own tool, which takes `upload_media`'s arguments plus the `forward` ones.
     */
    readonly tool?: string;
    /** Arguments of the rendering call's input the card repeats on each of its calls, such as a host's `server`. */
    readonly forward?: readonly string[];
    readonly title?: string;
    /** Passed through as `_meta.ui.domain`, for a host that serves each App from its own origin. */
    readonly domain?: string;
}
/**
 * The upload card, an MCP App that renders `upload_media` on `/mcp/admin`: the person picks an image, the card uploads it
 * straight to storage and commits it. Register it beside `adminMcpApps(...)` when `mcp(...)` has `media`. The page loads
 * on `resources/read` only.
 */
export function mediaUploadCard<Env = never>(options: MediaUploadCardOptions<Env>): NormalMcpApps {
    const uri = options.uri ?? "ui://mantle-admin/upload", tool = options.tool ?? "upload_media", forward = options.forward ?? [];
    // `<` escaped: the config sits in a script element
    const config = tool === "upload_media" && !forward.length ? "" :
        `<script type="application/json" id="mantle-upload-config">${JSON.stringify({ tool, forward }).replace(/</g, "\\u003c")}</script>`;
    if (!/^ui:\/\/mantle-admin\/[^\s?#]+$/.test(uri))
        throw new ContractError("INPUT_VALIDATION_FAILED", "Admin App resources use ui://mantle-admin/….", "mcp/apps");
    return { resources: [{
        uri, name: "mantle-admin-upload", title: options.title ?? "Upload media", renders: [tool],
        description: "Pick an image and upload it to the media library.",
        ...(options.domain !== undefined ? { domain: options.domain } : {}),
        html: async ({ env }) => {
            const origin = options.media(env as Env).uploadOrigin;
            if (!origin || !URL.canParse(origin) || new URL(origin).origin !== origin)
                throw new Error("mediaUploadCard: the media storage needs `uploadOrigin`, the origin its upload URLs PUT to (such as https://bucket.example.com).");
            const { default: html } = await import("./upload-card.js");
            if (!html) throw new Error("mediaUploadCard: the card is built into dist by the package build.");
            return { html: config ? html.replace("<head>", "<head>" + config) : html, csp: { connectDomains: [origin] } };
        },
    }] };
}
