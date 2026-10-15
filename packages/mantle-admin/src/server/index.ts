import type { GatewayOptions } from "@aotter/mantle/contracts";
/** Optional Admin API: generated data and native calls, with one fresh admin session per request. */
import { forwarded, deny, isAdmin, ContractError, checkOrigin, surfaceCaller, type Caller, type Target, type Authorize, type Gateway, type RequestContext } from "@aotter/mantle/contracts";
import { nativeRest, body, type Route as RestRoute } from "@aotter/mantle/rest";
import { userOf } from "@aotter/mantle/auth";
import { callToolLazy as callTool } from "@aotter/mantle/mcp";
import { convert, type Conversions } from "@aotter/mantle/surface";
import { siteInfo, type MantleSite, type MediaStorage } from "@aotter/mantle/site";
import { csv } from "./csv.js";
export type Admin = (Extract<Caller, { kind: "user" }> & { readonly admin: true; readonly credential: "session" }) | (Extract<Caller, { kind: "host" }> & { readonly admin: true });
export interface Context<Env, Database> {
    request: Request;
    url: URL;
    env: Env;
    db: Database;
    caller: Admin;
    params: Record<string, string>;
    input?: Record<string, unknown>;
    /** Request-bound application gate for related collection reads. */
    authorize?: (target: Target) => Promise<boolean>;
}
export interface Route<Env, Database> {
    readonly target?: (context: Context<Env, Database>) => Target;
    readonly prepare?: (context: Context<Env, Database>) => void | Promise<void>;
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
    readonly adminRoles?: readonly string[];
    listUsers(): Promise<readonly IdentityUser[]>;
    listMembers(args: {
        search?: string;
        limit?: number;
        cursor?: string;
        cursorDirection?: "forward" | "backward";
    }): Promise<{
        items: readonly (Pick<IdentityUser, "id" | "email" | "name" | "emailVerified" | "createdAt"> & { role?: string | null })[];
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
export interface Options<Env, Database> extends GatewayOptions {
    authorize?: Authorize;
    gateway?: Gateway;
    fields?: import("@aotter/mantle/user-fields").UserFields;
    locale?: string;
    /** Read-only developer preview bindings, including public Views. */
    developerViews?: readonly View<Database>[];
    db: (env: Env) => Database;
    caller?: (request: Request, env: Env) => Caller | Promise<Caller>;
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
    readonly accessTargets?: GatewayOptions["accessTargets"];
    readonly userFields?: import("@aotter/mantle/user-fields").UserFields;
    /** Generated requires guards for metadata targets beyond callable Admin routes. */
    readonly allows?: (target: Target, caller: Caller) => boolean;
    readonly collections: readonly Descriptor[];
    readonly allCollections?: Readonly<Record<string, Descriptor>>;
    readonly views: readonly Descriptor[];
    readonly operations: readonly Descriptor[];
    readonly webmcp: unknown;
    readonly developerConsole?: unknown;
    /** Project sidebar groups (`navGroups`); Schemas, admin Views and pages place items in them with `nav.group`. */
    readonly navGroups?: readonly import("./extension-types.js").AdminNavGroup[];
}
export interface View<Database> {
    readonly name: string;
    readonly check?: (caller: Caller) => void;
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
    readonly readOnly?: boolean;
    readonly name: string;
    readonly check?: (caller: Caller) => void;
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
}): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
    const sees = (items: readonly Descriptor[], routes: readonly {
        name: string;
        allows: (caller: Caller) => boolean;
    }[], caller: Caller) => items.filter(item => routes.some(route => route.name === item.name && route.allows(caller)));
    const missing = () => new ContractError("NOT_FOUND", "No such Admin route.", "admin");
    const localized = (value: unknown) => typeof value === "string" ? value : value && typeof value === "object" ? (value as Record<string, string>)[options.locale ?? "en"] ?? (value as Record<string, string>).en ?? Object.values(value)[0] : undefined;
    const webmcp = metadata.webmcp as { tools?: readonly Record<string, unknown>[] };
    const catalogue = { ...webmcp, tools: webmcp.tools?.map(tool => { const {target: _target, ...display} = tool; return { ...display, ...(tool.title ? { title: localized(tool.title) } : {}), description: localized(tool.description) ?? localized(tool.title) ?? tool.name }; }) };
    const me = async ({ caller, request, env }: Context<Env, Database>) => { const user = (options.getUser ? await options.getUser(caller.subject, request, env) : undefined) ?? userOf(caller); return { userId: caller.subject, role: caller.role, admin: isAdmin(caller), login: user?.githubLogin || user?.name || user?.email || null, image: user?.image ?? null }; };
    const site = async (c: Context<Env, Database>) => { const info = siteInfo(options.site ? await options.site(c.db, c.caller).read() : { brand: "AotterMantle", title: "CMS", description: "", origin: "", locales: [], canonicalLocale: null, icons: [{ src: "/admin/favicon.png", mimeType: "image/png", sizes: ["64x64"] }, { src: "/admin/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] }], media: { purposes: [] } }, { origin: c.url.origin, siteSettings: !!options.site, media: !!options.site && !!options.media, invitationEmail: !!options.identity?.roles?.sendAdminInvitation, mcpEndpoints: options.mcpEndpoints, extensions: options.extensions }); return { ...info, navGroups: metadata.navGroups ?? [], capabilities: { ...info.capabilities, statistics: !!options.routes?.some(route => route.path === "/collections/{name}/statistics") } }; };
    const checkTarget = async (target: Target, caller: Caller) => (await import("@aotter/mantle/authorization")).authorizeTarget(options.authorize!, target, caller);
    const visibleMetadata = async (c: Context<Env, Database>) => {
        if (!options.authorize) return { ...metadata, views: sees(metadata.views, views, c.caller), operations: sees(metadata.operations, operations, c.caller), webmcp: catalogue };
        return (await import("./authorization.js")).visibleMetadata(metadata, catalogue, views, operations, options.developerViews ?? views, options.authorize, c.caller);
    };
    const runRoute = (route: Route<Env, Database>, c: Context<Env, Database>) => options.authorize && route.target
        ? checkTarget(route.target(c), c.caller).then(() => route.run(c)) : route.run(c);
    const viewPage = async (c: Context<Env, Database>, preview = false) => {
        const view = (preview ? options.developerViews ?? views : views).find(v => v.name === c.params.name && (options.authorize || v.allows(c.caller)));
        if (view && options.authorize) deny(c.caller, view.allows(c.caller), "views/" + view.name);
        if (!view) { if (preview) return { unavailable: true }; throw missing(); }
        if (options.authorize) await checkTarget({ kind: "view", name: view.name }, c.caller);
        const { input: raw, ...paging } = view.query(c.url.searchParams), input = { ...raw };
        convert(input, view.convert);
        const page = await view.page(c.db, c.caller, input as never, paging);
        return view.row ? { ...page, rows: page.rows.map(view.row) } : page;
    };
    const routes: readonly Route<Env, Database>[] = [
        { method: "GET", path: "/me", run: me }, { method: "GET", path: "/site", run: site },
        { method: "GET", path: "/collections", run: c => {
            const result = (m: Metadata) => ({collections: m.collections, allCollections: m.allCollections ?? Object.fromEntries(m.collections.map(c => [c.name, c]))});
            return options.authorize ? visibleMetadata(c).then(result) : result(metadata);
        } },
        { method: "GET", path: "/views-manifest", run: c => options.authorize ? visibleMetadata(c).then(m => ({views: m.views})) : {views: sees(metadata.views, views, c.caller)} },
        { method: "GET", path: "/operations", run: c => options.authorize ? visibleMetadata(c).then(m => ({operations: m.operations})) : {operations: sees(metadata.operations, operations, c.caller)} },
        { method: "GET", path: "/webmcp", run: c => options.authorize ? visibleMetadata(c).then(m => m.webmcp) : catalogue },
        { method: "GET", path: "/bootstrap", run: async c => {
                const list = c.url.searchParams.has("collection") ? options.routes?.find(route => route.path === "/entries" && route.method === "GET") : undefined;
                const [user, settings, entries] = await Promise.all([me(c), site(c), list ? Promise.resolve(runRoute(list, c)).catch(error => { if (options.authorize && (!(error instanceof ContractError) || error.code !== "AUTH_DENIED")) throw error; return undefined; }) : undefined]);
                const m = await visibleMetadata(c);
                return { me: user, site: settings, collections: m.collections, allCollections: m.allCollections, views: m.views, operations: m.operations, webmcp: m.webmcp, ...(entries ? { entries } : {}) };
            } },
        { method: "GET", path: "/views/{name}/export", run: async (c) => {
                const view = views.find(v => v.name === c.params.name && (options.authorize || v.allows(c.caller)));
                if (view && options.authorize) deny(c.caller, view.allows(c.caller), "views/" + view.name);
                if (!view) throw missing();
                if (options.authorize) await checkTarget({ kind: "view", name: view.name }, c.caller);
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
        { method: "GET", path: "/views/{name}", prepare: async c => { const view = views.find(v => v.name === c.params.name); if (!view) throw missing(); deny(c.caller, view.allows(c.caller), "views/" + view.name); view.check?.(c.caller); if (options.authorize) await checkTarget({kind:"view",name:view.name}, c.caller); const input = {...view.query(c.url.searchParams).input}; convert(input, view.convert); }, run: c => viewPage(c) },
        ...(metadata.developerConsole === undefined ? [] : [{ method: "GET" as const, path: "/developer/views/{name}", run: (c: Context<Env, Database>) => viewPage(c, true) }]),
        { method: "POST", path: "/operations/{name}", prepare: async c => {
            const operation = operations.find(p => p.name === c.params.name); if (!operation) throw missing();
            deny(c.caller, operation.allows(c.caller), "procedures/" + operation.name);
            operation.check?.(c.caller);
            if (options.authorize) await checkTarget({kind:"procedure",name:operation.name}, c.caller);
            convert(operation.validate(await json(c)), operation.convert);
        }, run: async (c) => {
                const operation = operations.find(p => p.name === c.params.name && (options.authorize || p.allows(c.caller)));
                if (operation && options.authorize) deny(c.caller, operation.allows(c.caller), "procedures/" + operation.name);
                if (!operation)
                    throw missing();
                if (options.authorize) await checkTarget({ kind: "procedure", name: operation.name }, c.caller);
                return { ok: true, output: await callTool({ ...operation, surface: "admin", description: "", inputSchema: {} }, await json(c), () => c.db, c.caller, options.handlers as Handlers) };
            } },
        ...(metadata.developerConsole === undefined ? [] : [{ method: "GET", path: "/developer-console", run: (c: Context<Env, Database>) => options.authorize ? visibleMetadata(c).then(m => m.developerConsole) : metadata.developerConsole }]),
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
        return { id: `admin:${route.method} ${route.path.replace(/\{([^}*]+)\*?\}/g, ":$1")}`, method: route.method, pattern: new RegExp("^/admin/api" + path + "/?$"), keys, bodyLimit: route.bodyLimit, rawBody: route.rawBody, handle: async (request, env, getDb, caller, params, _handlers, input) => {
                const result = await runRoute(route, { request, url: new URL(request.url), env, get db() { return getDb(); }, caller: caller as Admin, params, input, ...(options.authorize ? { authorize: (target: Target) => import("@aotter/mantle/authorization").then(m => m.authorized(options.authorize!, target, caller)) } : {}) });
                if (!(result instanceof Response))
                    return result;
                const headers = new Headers(result.headers);
                if (!route.preserveCacheControl || !headers.has("cache-control"))
                    headers.set("cache-control", "private, no-store");
                return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
            } };
    });
    return async (request, env, ctx) => {
        const path = new URL(request.url).pathname;
        if (path !== "/admin/api" && !path.startsWith("/admin/api/"))
            return;
        let caller: Caller | undefined;
        const access = options.gateway ? (await import("@aotter/mantle/host-access")).accessRequest(ctx, {...options, accessTargets: options.accessTargets ?? metadata.accessTargets}) : undefined;
        const matched = table.find(r => r.method === request.method && r.pattern.test(path));
        const targetId = matched?.id ?? `admin:${request.method} ${path.slice(10)}`;
        try {
            await access?.select(targetId);
            caller = forwarded(ctx, options.gateway)
                ? (await import("@aotter/mantle/host-caller")).gatewayCaller(ctx, options.gateway, options.fields ?? metadata.userFields)
                : await surfaceCaller(request, env, options.caller ?? (() => ({ kind: "anonymous" })));
            await access?.select(targetId, caller);
            if (caller.kind === "anonymous")
                throw new ContractError("UNAUTHENTICATED", "Sign in to use Admin.", "admin");
            if (!isAdmin(caller) || caller.kind !== "host" && caller.credential !== "session") {
                if (options.gateway) throw new ContractError("AUTH_DENIED", "Admin layer required.", "admin");
                return Response.json({ error: { code: "AUTH_DENIED", message: "Admin needs a signed-in admin session.", path: "admin" }, minimumRole: "admin" }, { status: 403, headers: { "cache-control": "private, no-store" } });
            }
            const operation = options.gateway ? /^\/admin\/api\/operations\/([^/]+)\/?$/.exec(path) : null;
            const readOnly = ["GET", "HEAD", "OPTIONS"].includes(request.method) || request.method === "POST" && !!operation && operations.some(p => p.name === decodeURIComponent(operation[1]!) && p.readOnly === true);
            if (options.gateway) {
                const { checkFresh } = await import("@aotter/mantle/host-caller");
                const view = /\/views\/([^/]+)/.exec(path);
                const variant = operation ? `procedure:${decodeURIComponent(operation[1]!)}` : view ? `view:${decodeURIComponent(view[1]!)}` : undefined;
                if (matched) await access?.check(readOnly, variant);
                if (!matched) checkFresh(caller, readOnly, path);
            }
            checkOrigin(request, caller);
            try {
                decodeURIComponent(path);
            }
            catch {
                throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed Admin path.", "admin");
            }
            if (/%2f|%5c|%00/i.test(path) || path.includes("\\"))
                throw new ContractError("INPUT_VALIDATION_FAILED", "Malformed Admin path.", "admin");
            if (access?.dryRun) {
                if (!matched) throw missing();
                const route = routes[table.indexOf(matched)]!;
                if (!route.prepare) throw new ContractError("DRY_RUN_UNSUPPORTED", "Opaque Admin work.", matched.id, {status:412});
                const params = Object.fromEntries((matched.keys ?? []).map((key, i) => [key, decodeURIComponent(matched.pattern.exec(path)![i + 1]!)]));
                const input = ["GET", "HEAD", "OPTIONS"].includes(request.method) ? undefined : await body(request, route.bodyLimit);
                const c: Context<Env, Database> = {request, url:new URL(request.url), env, get db(): Database { throw new Error("Dry run attempted database acquisition"); }, caller:caller as Admin, params, input, ...(options.authorize ? {authorize:(target:Target)=>import("@aotter/mantle/authorization").then(m=>m.authorized(options.authorize!,target,caller!))} : {})};
                if (options.authorize && route.target) await checkTarget(route.target(c), caller);
                await route.prepare(c);
                return access.response();
            }
            const response = await nativeRest(table.map(r => r === matched ? {...r, readOnly} : r), { accessTargets: options.accessTargets ?? metadata.accessTargets, gateway: options.gateway, fields: options.fields ?? metadata.userFields, db: options.db, caller: () => caller!, handlers: options.handlers })(request, env, ctx);
            if (!response) throw missing();
            await access?.finishResponse(response);
            return response;
        }
        catch (error) {
            access?.finish(error);
            return (await import("@aotter/mantle/host-caller")).hostFailure(error, caller, "admin");
        }
    };
}
export { adminShell } from "./shell.js";
