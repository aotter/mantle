/** Optional Admin API: generated data and native calls, with one fresh admin session per request. */
import { isAdmin, ContractError, checkOrigin, surfaceCaller, surfaceFailure, type Caller } from "@aotter/mantle/contracts";
import { nativeRest, body, type Route as RestRoute } from "@aotter/mantle/rest";
import { sessionUserOf } from "@aotter/mantle/auth";
import { callToolLazy as callTool } from "@aotter/mantle/mcp";
import { convert, type Conversions } from "@aotter/mantle/surface";
import { siteInfo, type MantleSite, type MediaStorage } from "@aotter/mantle/site";
import { csv } from "./csv.js";
export type Admin = Extract<Caller, {
    kind: "user";
}> & {
    readonly admin: true;
    readonly credential: "session";
};
export interface Context<Env, Database> {
    request: Request;
    url: URL;
    env: Env;
    db: Database;
    caller: Admin;
    params: Record<string, string>;
    input?: Record<string, unknown>;
}
export interface Route<Env, Database> {
    readonly method: string;
    /** Relative to /admin/api; {name} captures one segment, {name*} captures a suffix. */
    readonly path: string;
    readonly bodyLimit?: number;
    readonly rawBody?: boolean;
    readonly preserveCacheControl?: boolean;
    run(context: Context<Env, Database>): Promise<unknown> | unknown;
}
export interface IdentityUser {
    id: string;
    email: string;
    name: string;
    role: string | null;
    githubLogin: string | null;
    emailVerified: boolean;
    createdAt: Date;
}
export interface IdentityMethods {
    listUsers(): Promise<readonly IdentityUser[]>;
    listMembers(args: {
        search?: string;
        limit?: number;
        cursor?: string;
        cursorDirection?: "forward" | "backward";
    }): Promise<{
        items: readonly Pick<IdentityUser, "id" | "email" | "name" | "emailVerified" | "createdAt">[];
        previousCursor: string | null;
        nextCursor: string | null;
    }>;
    setUserRole(id: string, role: string | null): Promise<boolean>;
    inviteUser(email: string, role?: string): Promise<{
        kind: "created" | "exists";
        id: string;
    }>;
    revokeInvite(id: string): Promise<boolean>;
}
export interface Options<Env, Database> {
    locale?: string;
    /** Read-only developer preview bindings, including public Views. */
    developerViews?: readonly View<Database>[];
    db: (env: Env) => Database;
    caller: (request: Request, env: Env) => Caller | Promise<Caller>;
    getUser?: (subject: string, request: Request, env: Env) => Promise<{
        githubLogin?: string | null;
        name?: string | null;
        email?: string | null;
        image?: string | null;
    } | null>;
    site?: (db: Database, caller: Caller) => MantleSite;
    media?: MediaStorage;
    identity?: {
        directory?: (context: Context<Env, Database>) => Partial<IdentityMethods> | Promise<Partial<IdentityMethods>>;
        roles?: {
            sendAdminInvitation?: (email: string, role: string) => Promise<void>;
        };
    };
    mcpEndpoints?: {
        public?: string | null;
        admin?: string | null;
    };
    extensions?: readonly unknown[];
    routes?: readonly Route<Env, Database>[];
}
export interface Descriptor {
    readonly name: string;
    readonly [key: string]: unknown;
}
export interface Metadata {
    readonly collections: readonly Descriptor[];
    readonly allCollections?: Readonly<Record<string, Descriptor>>;
    readonly views: readonly Descriptor[];
    readonly operations: readonly Descriptor[];
    readonly webmcp: unknown;
    readonly developerConsole?: unknown;
}
export interface View<Database> {
    readonly name: string;
    readonly allows: (caller: Caller) => boolean;
    /** Generated query validation also owns selected search/filter inputs. */
    readonly query: (params: URLSearchParams) => {
        input: Record<string, unknown>;
        limit?: number;
        cursor?: string;
        match?: Record<string, unknown>;
    };
    readonly page: (db: Database, caller: Caller, input: never, paging: {
        limit?: number;
        cursor?: string;
        match?: Record<string, unknown>;
    }) => Promise<{
        rows: readonly Record<string, unknown>[];
        nextCursor?: string;
    }>;
    readonly convert?: Conversions;
    readonly row?: (row: Record<string, unknown>) => Record<string, unknown>;
}
export interface Operation<Database, Handlers> {
    readonly name: string;
    readonly allows: (caller: Caller) => boolean;
    readonly validate: (raw: unknown) => Record<string, unknown>;
    readonly convert?: Conversions;
    readonly run: (db: Database, caller: Caller, input: never, handlers: Handlers) => Promise<unknown>;
}
export { body };
/** JSON was bounded by the shared router before acquiring the database. */
export const json = (context: Context<unknown, unknown>): Promise<Record<string, unknown>> => context.input ? Promise.resolve(context.input) : body(context.request);
export function admin<Env, Database, Handlers = never>(metadata: Metadata, views: readonly View<Database>[], operations: readonly Operation<Database, Handlers>[], options: Options<Env, Database> & {
    handlers?: Handlers;
}): (request: Request, env: Env) => Promise<Response | undefined> {
    const sees = (items: readonly Descriptor[], routes: readonly {
        name: string;
        allows: (caller: Caller) => boolean;
    }[], caller: Caller) => items.filter(item => routes.some(route => route.name === item.name && route.allows(caller)));
    const missing = () => new ContractError("NOT_FOUND", "No such Admin route.", "admin");
    const localized = (value: unknown) => typeof value === "string" ? value : value && typeof value === "object" ? (value as Record<string, string>)[options.locale ?? "en"] ?? (value as Record<string, string>).en ?? Object.values(value)[0] : undefined;
    const webmcp = metadata.webmcp as { tools?: readonly Record<string, unknown>[] };
    const catalogue = { ...webmcp, tools: webmcp.tools?.map(tool => ({ ...tool, ...(tool.title ? { title: localized(tool.title) } : {}), description: localized(tool.description) ?? localized(tool.title) ?? tool.name })) };
    const me = async ({ caller, request, env }: Context<Env, Database>) => { const user = (options.getUser ? await options.getUser(caller.subject, request, env) : undefined) ?? sessionUserOf(caller); return { userId: caller.subject, role: caller.role, admin: true, login: user?.githubLogin || user?.name || user?.email || null, image: user?.image ?? null }; };
    const site = async (c: Context<Env, Database>) => { const info = siteInfo(options.site ? await options.site(c.db, c.caller).read() : { brand: "AotterMantle", title: "CMS", description: "", origin: "", locales: [], canonicalLocale: null, icons: [{ src: "/admin/favicon.png", mimeType: "image/png", sizes: ["64x64"] }, { src: "/admin/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] }], media: { purposes: [] } }, { origin: c.url.origin, siteSettings: !!options.site, media: !!options.site && !!options.media, invitationEmail: !!options.identity?.roles?.sendAdminInvitation, mcpEndpoints: options.mcpEndpoints, extensions: options.extensions }); return { ...info, capabilities: { ...info.capabilities, statistics: !!options.routes?.some(route => route.path === "/collections/{name}/statistics") } }; };
    const viewPage = async (c: Context<Env, Database>, preview = false) => {
        const view = (preview ? options.developerViews ?? views : views).find(v => v.name === c.params.name && v.allows(c.caller));
        if (!view) { if (preview) return { unavailable: true }; throw missing(); }
        const { input: raw, ...paging } = view.query(c.url.searchParams), input = { ...raw };
        convert(input, view.convert);
        const page = await view.page(c.db, c.caller, input as never, paging);
        return view.row ? { ...page, rows: page.rows.map(view.row) } : page;
    };
    const routes: readonly Route<Env, Database>[] = [
        { method: "GET", path: "/me", run: me }, { method: "GET", path: "/site", run: site },
        { method: "GET", path: "/collections", run: () => ({ collections: metadata.collections, allCollections: metadata.allCollections ?? Object.fromEntries(metadata.collections.map(c => [c.name, c])) }) },
        { method: "GET", path: "/views-manifest", run: c => ({ views: sees(metadata.views, views, c.caller) }) },
        { method: "GET", path: "/operations", run: c => ({ operations: sees(metadata.operations, operations, c.caller) }) },
        { method: "GET", path: "/webmcp", run: () => catalogue },
        { method: "GET", path: "/bootstrap", run: async c => {
                const list = c.url.searchParams.has("collection") ? options.routes?.find(route => route.path === "/entries" && route.method === "GET") : undefined;
                const [user, settings, entries] = await Promise.all([me(c), site(c), list ? Promise.resolve(list.run(c)).catch(() => undefined) : undefined]);
                return { me: user, site: settings, collections: metadata.collections, allCollections: metadata.allCollections, views: sees(metadata.views, views, c.caller), operations: sees(metadata.operations, operations, c.caller), webmcp: catalogue, ...(entries ? { entries } : {}) };
            } },
        { method: "GET", path: "/views/{name}/export", run: async (c) => {
                const view = views.find(v => v.name === c.params.name && v.allows(c.caller));
                if (!view) throw missing();
                const params = new URLSearchParams(c.url.searchParams);
                params.delete("cursor"); params.set("limit", "500");
                const {input: raw, ...paging} = view.query(params), input = {...raw};
                convert(input, view.convert);
                const descriptor = metadata.views.find(v => v.name === view.name);
                const columns = (descriptor?.list as {columns?: readonly string[]} | undefined)?.columns;
                return csv(view.name, async cursor => {
                    const page = await view.page(c.db, c.caller, input as never, {...paging, limit: 500, cursor});
                    return view.row ? {...page, rows: page.rows.map(view.row)} : page;
                }, columns);
            } },
        { method: "GET", path: "/views/{name}", run: c => viewPage(c) },
        ...(metadata.developerConsole === undefined ? [] : [{ method: "GET" as const, path: "/developer/views/{name}", run: (c: Context<Env, Database>) => viewPage(c, true) }]),
        { method: "POST", path: "/operations/{name}", run: async (c) => {
                const operation = operations.find(p => p.name === c.params.name && p.allows(c.caller));
                if (!operation)
                    throw missing();
                return { ok: true, output: await callTool({ ...operation, surface: "admin", description: "", inputSchema: {} }, await json(c), () => c.db, c.caller, options.handlers as Handlers) };
            } },
        ...(metadata.developerConsole === undefined ? [] : [{ method: "GET", path: "/developer-console", run: () => metadata.developerConsole }]),
        ...(options.routes ?? []),
    ];
    const table: RestRoute<Database, Handlers, Env>[] = routes.map(route => {
        const keys: string[] = [];
        const path = route.path.split("/").map(segment => {
            const part = /^\{([a-zA-Z][\w]*)(\*)?\}$/.exec(segment);
            if (part) {
                keys.push(part[1]!);
                return part[2] ? "(.*)" : "([^/]+)";
            }
            return encodeURIComponent(segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("/");
        return { method: route.method, pattern: new RegExp("^/admin/api" + path + "/?$"), keys, bodyLimit: route.bodyLimit, rawBody: route.rawBody, handle: async (request, env, getDb, caller, params, _handlers, input) => {
                const result = await route.run({ request, url: new URL(request.url), env, get db() { return getDb(); }, caller: caller as Admin, params, input });
                if (!(result instanceof Response))
                    return result;
                const headers = new Headers(result.headers);
                if (!route.preserveCacheControl || !headers.has("cache-control"))
                    headers.set("cache-control", "private, no-store");
                return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
            } };
    });
    return async (request, env) => {
        const path = new URL(request.url).pathname;
        if (path !== "/admin/api" && !path.startsWith("/admin/api/"))
            return;
        try {
            const caller = await surfaceCaller(request, env, options.caller);
            if (caller.kind === "anonymous")
                throw new ContractError("UNAUTHENTICATED", "Sign in to use Admin.", "admin");
            if (!isAdmin(caller) || caller.credential !== "session")
                return Response.json({ error: { code: "AUTH_DENIED", message: "Admin needs a signed-in admin session.", path: "admin" }, minimumRole: "admin" }, { status: 403, headers: { "cache-control": "private, no-store" } });
            checkOrigin(request, caller);
            try {
                decodeURIComponent(path);
            }
            catch {
                throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed Admin path.", "admin");
            }
            if (/%2f|%5c|%00/i.test(path) || path.includes("\\"))
                throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed Admin path.", "admin");
            return await nativeRest(table, { db: options.db, caller: () => caller, handlers: options.handlers })(request, env) ?? surfaceFailure(missing());
        }
        catch (error) {
            return surfaceFailure(error);
        }
    };
}
export { adminShell } from "./shell.js";
