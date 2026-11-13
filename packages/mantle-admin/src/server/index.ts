import type { GatewayOptions } from "@aotter/mantle/contracts";
/** Optional Admin API: generated data and native calls, with one fresh admin session per request. */
import {
  convertInput as convert,
  deny,
  isAdmin,
  ContractError,
  type Caller,
  type Target,
  type Authorize,
  type Gateway,
  type RequestContext,
  type Conversions,
} from "@aotter/mantle/contracts";
import {
  nativeRest,
  body,
  ADMIN_API_BASE,
  routeSource,
  type Route as RestRoute,
  type RouteAccess,
} from "@aotter/mantle/rest";
import { userOf } from "@aotter/mantle/auth";
import { callToolLazy as callTool } from "@aotter/mantle/mcp";
import { siteInfo, type MantleSite, type MediaStorageOption } from "@aotter/mantle/site";
import { csv } from "./csv.js";
export type Admin =
  | (Extract<Caller, { kind: "user" }> & { readonly admin: true; readonly credential: "session" })
  | (Extract<Caller, { kind: "host" }> & { readonly admin: true });
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
  /** What application `authorize` decides on, from the request (`params`, `input`, `url`, `caller`); not `db` or `authorize`. */
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
    items: readonly (Pick<IdentityUser, "id" | "email" | "name" | "emailVerified" | "createdAt"> & {
      role?: string | null;
    })[];
    previousCursor: string | null;
    nextCursor: string | null;
  }>;
  setUserRole(id: string, role: string | null): Promise<boolean>;
  inviteUser(
    email: string,
    role?: string,
  ): Promise<{
    kind: "created" | "exists";
    id: string;
  }>;
  revokeInvite(id: string): Promise<boolean>;
}
export interface Options<Env, Database> extends GatewayOptions {
  authorize?: Authorize;
  gateway?: Gateway;
  fields?: import("@aotter/mantle/contracts").UserFields;
  locale?: string;
  /** Read-only developer preview bindings, including public Views. */
  developerViews?: readonly View<Database>[];
  db: (env: Env) => Database;
  caller?: (request: Request, env: Env) => Caller | Promise<Caller>;
  getUser?: (
    subject: string,
    request: Request,
    env: Env,
  ) => Promise<{
    githubLogin?: string | null;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  } | null>;
  site?: (db: Database, caller: Caller) => MantleSite;
  /** One storage for all-public media, or `{ public, private }` when a purpose is private. */
  media?: MediaStorageOption;
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
  routes?: readonly Route<Env, Database>[];
}
export interface Descriptor {
  readonly name: string;
  readonly [key: string]: unknown;
}
export interface Metadata {
  readonly accessTargets?: GatewayOptions["accessTargets"];
  readonly userFields?: import("@aotter/mantle/contracts").UserFields;
  /** Generated requires guards for metadata targets beyond callable Admin routes. */
  readonly allows?: (target: Target, caller: Caller) => boolean;
  readonly collections: readonly Descriptor[];
  readonly allCollections?: Readonly<Record<string, Descriptor>>;
  readonly views: readonly Descriptor[];
  readonly operations: readonly Descriptor[];
  readonly webmcp: unknown;
  /** The developer snapshot, or a function that loads it (generated output imports it on first use, outside Worker startup). */
  readonly developerConsole?: unknown;
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
  readonly page: (
    db: Database,
    caller: Caller,
    input: never,
    paging: {
      limit?: number;
      cursor?: string;
      match?: Record<string, unknown>;
    },
  ) => Promise<{
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
export const json = (context: Context<unknown, unknown>): Promise<Record<string, unknown>> =>
  context.input ? Promise.resolve(context.input) : body(context.request);
export function admin<Env, Database, Handlers = never>(
  metadata: Metadata,
  views: readonly View<Database>[],
  operations: readonly Operation<Database, Handlers>[],
  options: Options<Env, Database> & {
    handlers?: Handlers;
  },
): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  const sees = (
    items: readonly Descriptor[],
    routes: readonly {
      name: string;
      allows: (caller: Caller) => boolean;
    }[],
    caller: Caller,
  ) => items.filter(item => routes.some(route => route.name === item.name && route.allows(caller)));
  const missing = () => new ContractError("NOT_FOUND", "No such Admin route.", "admin");
  const localized = (value: unknown) =>
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? ((value as Record<string, string>)[options.locale ?? "en"] ??
          (value as Record<string, string>).en ??
          Object.values(value)[0])
        : undefined;
  const webmcp = metadata.webmcp as { tools?: readonly Record<string, unknown>[] };
  const catalogue = {
    ...webmcp,
    tools: webmcp.tools?.map(tool => {
      const { target: _target, ...display } = tool;
      return {
        ...display,
        ...(tool.title ? { title: localized(tool.title) } : {}),
        description: localized(tool.description) ?? localized(tool.title) ?? tool.name,
      };
    }),
  };
  const me = async ({ caller, request, env }: Context<Env, Database>) => {
    const user = (options.getUser ? await options.getUser(caller.subject, request, env) : undefined) ?? userOf(caller);
    return {
      userId: caller.subject,
      role: caller.role,
      admin: isAdmin(caller),
      login: user?.githubLogin || user?.name || user?.email || null,
      image: user?.image ?? null,
    };
  };
  const site = async (c: Context<Env, Database>) => {
    const info = siteInfo(
      options.site
        ? await options.site(c.db, c.caller).read()
        : {
            brand: "AotterMantle",
            title: "CMS",
            description: "",
            origin: "",
            locales: [],
            canonicalLocale: null,
            icons: [
              { src: "/admin/favicon.png", mimeType: "image/png", sizes: ["64x64"] },
              { src: "/admin/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
            ],
            media: { purposes: [] },
          },
      {
        origin: c.url.origin,
        siteSettings: !!options.site,
        media: !!options.site && !!options.media,
        invitationEmail: !!options.identity?.roles?.sendAdminInvitation,
        mcpEndpoints: options.mcpEndpoints,
      },
    );
    return {
      ...info,
      capabilities: {
        ...info.capabilities,
        statistics: !!options.routes?.some(route => route.path === "/collections/{name}/statistics"),
        // Members and Admins manage identities: only when a directory is configured and the caller is not a host (whose identities are managed by the host)
        identity: !!options.identity?.directory && !(await import("@aotter/mantle/host-caller")).isHostCaller(c.caller),
      },
    };
  };
  // Application `authorize`, bound to the request's caller by the pipeline; a context reaches it through here.
  const access = new WeakMap<Context<Env, Database>, RouteAccess>();
  const checkTarget = (c: Context<Env, Database>, target: Target) => access.get(c)!.authorize(target);
  const developerConsole = async () =>
    typeof metadata.developerConsole === "function"
      ? await (metadata.developerConsole as () => unknown)()
      : metadata.developerConsole;
  // only the developer-console route resolves and filters the snapshot
  const visibleMetadata = async (c: Context<Env, Database>, developer = false) => {
    if (!options.authorize)
      return {
        ...metadata,
        views: sees(metadata.views, views, c.caller),
        operations: sees(metadata.operations, operations, c.caller),
        webmcp: catalogue,
      };
    return (await import("./authorization.js")).visibleMetadata(
      metadata,
      catalogue,
      views,
      operations,
      options.developerViews ?? views,
      c.authorize!,
      c.caller,
      developer ? await developerConsole() : undefined,
    );
  };
  const batchNames = (url: URL): string[] => {
    const names = [...new Set((url.searchParams.get("names") ?? "").split(",").filter(Boolean))];
    if (!names.length || names.length > 20)
      /* same cap as MAX_BADGE_VIEWS in admin/src/app/transport.ts */ throw new ContractError(
        "INPUT_VALIDATION_FAILED",
        "Name 1 to 20 Views in `names`, separated by commas.",
        "admin",
      );
    return names;
  };
  const runRoute = (route: Route<Env, Database>, c: Context<Env, Database>) =>
    options.authorize && route.target ? checkTarget(c, route.target(c)).then(() => route.run(c)) : route.run(c);
  const viewPage = async (
    c: Context<Env, Database>,
    preview = false,
    name = c.params.name,
    search = c.url.searchParams,
  ) => {
    const view = (preview ? (options.developerViews ?? views) : views).find(
      v => v.name === name && (options.authorize || v.allows(c.caller)),
    );
    if (view && options.authorize) deny(c.caller, view.allows(c.caller), "views/" + view.name);
    if (!view) {
      if (preview) return { unavailable: true };
      throw missing();
    }
    if (options.authorize) await checkTarget(c, { kind: "view", name: view.name });
    const { input: raw, ...paging } = view.query(search),
      input = { ...raw };
    convert(input, view.convert);
    const page = await view.page(c.db, c.caller, input as never, paging);
    return view.row ? { ...page, rows: page.rows.map(view.row) } : page;
  };
  const routes: readonly Route<Env, Database>[] = [
    { method: "GET", path: "/me", run: me },
    { method: "GET", path: "/site", run: site },
    {
      method: "GET",
      path: "/collections",
      run: c => {
        const result = (m: Metadata) => ({
          collections: m.collections,
          allCollections: m.allCollections ?? Object.fromEntries(m.collections.map(c => [c.name, c])),
        });
        return options.authorize ? visibleMetadata(c).then(result) : result(metadata);
      },
    },
    {
      method: "GET",
      path: "/views-manifest",
      run: c =>
        options.authorize
          ? visibleMetadata(c).then(m => ({ views: m.views }))
          : { views: sees(metadata.views, views, c.caller) },
    },
    {
      method: "GET",
      path: "/operations",
      run: c =>
        options.authorize
          ? visibleMetadata(c).then(m => ({ operations: m.operations }))
          : { operations: sees(metadata.operations, operations, c.caller) },
    },
    {
      method: "GET",
      path: "/webmcp",
      run: c => (options.authorize ? visibleMetadata(c).then(m => m.webmcp) : catalogue),
    },
    {
      method: "GET",
      path: "/bootstrap",
      run: async c => {
        const list = c.url.searchParams.has("collection")
          ? options.routes?.find(route => route.path === "/entries" && route.method === "GET")
          : undefined;
        const [user, settings, entries] = await Promise.all([
          me(c),
          site(c),
          list
            ? Promise.resolve(runRoute(list, c)).catch(error => {
                if (options.authorize && (!(error instanceof ContractError) || error.code !== "AUTH_DENIED"))
                  throw error;
                return undefined;
              })
            : undefined,
        ]);
        const m = await visibleMetadata(c);
        return {
          me: user,
          site: settings,
          collections: m.collections,
          allCollections: m.allCollections,
          views: m.views,
          operations: m.operations,
          webmcp: m.webmcp,
          ...(entries ? { entries } : {}),
        };
      },
    },
    {
      method: "GET",
      path: "/views/{name}/export",
      run: async c => {
        const view = views.find(v => v.name === c.params.name && (options.authorize || v.allows(c.caller)));
        if (view && options.authorize) deny(c.caller, view.allows(c.caller), "views/" + view.name);
        if (!view) throw missing();
        if (options.authorize) await checkTarget(c, { kind: "view", name: view.name });
        const params = new URLSearchParams(c.url.searchParams);
        params.delete("cursor");
        params.set("limit", "500");
        const { input: raw, ...paging } = view.query(params),
          input = { ...raw };
        convert(input, view.convert);
        const descriptor = metadata.views.find(v => v.name === view.name);
        const columns = (descriptor?.list as { columns?: readonly string[] } | undefined)?.columns;
        return csv(
          view.name,
          async cursor => {
            const page = await view.page(c.db, c.caller, input as never, { ...paging, limit: 500, cursor });
            return view.row ? { ...page, rows: page.rows.map(view.row) } : page;
          },
          columns,
        );
      },
    },
    {
      method: "GET",
      path: "/views/{name}",
      prepare: async c => {
        const view = views.find(v => v.name === c.params.name);
        if (!view) throw missing();
        deny(c.caller, view.allows(c.caller), "views/" + view.name);
        view.check?.(c.caller);
        if (options.authorize) await checkTarget(c, { kind: "view", name: view.name });
        const input = { ...view.query(c.url.searchParams).input };
        convert(input, view.convert);
      },
      run: c => viewPage(c),
    },
    // Nav badges: up to 20 Views in one read, each as the caller through the single route's checks. A refused or missing View
    // is the same `{ unavailable: true }`; a View that cannot answer with no input is `{ error: true }`, and neither fails the batch.
    {
      method: "GET",
      path: "/view-batch",
      prepare: c => {
        batchNames(c.url);
      },
      run: async c => {
        const out: [string, unknown][] = [];
        for (const name of batchNames(c.url)) {
          try {
            out.push([name, await viewPage(c, false, name, new URLSearchParams({ limit: "1" }))]);
          } catch (error) {
            if (!(error instanceof ContractError)) throw error;
            out.push([
              name,
              ["AUTH_DENIED", "UNAUTHENTICATED", "NOT_FOUND"].includes(error.code)
                ? { unavailable: true }
                : { error: true },
            ]);
          }
        }
        return { views: Object.fromEntries(out) };
      },
    },
    ...(metadata.developerConsole === undefined
      ? []
      : [
          {
            method: "GET" as const,
            path: "/developer/views/{name}",
            run: (c: Context<Env, Database>) => viewPage(c, true),
          },
        ]),
    {
      method: "POST",
      path: "/operations/{name}",
      prepare: async c => {
        const operation = operations.find(p => p.name === c.params.name);
        if (!operation) throw missing();
        deny(c.caller, operation.allows(c.caller), "procedures/" + operation.name);
        operation.check?.(c.caller);
        if (options.authorize) await checkTarget(c, { kind: "procedure", name: operation.name });
        convert(operation.validate(await json(c)), operation.convert);
      },
      run: async c => {
        const operation = operations.find(p => p.name === c.params.name && (options.authorize || p.allows(c.caller)));
        if (operation && options.authorize) deny(c.caller, operation.allows(c.caller), "procedures/" + operation.name);
        if (!operation) throw missing();
        if (options.authorize) await checkTarget(c, { kind: "procedure", name: operation.name });
        return {
          ok: true,
          output: await callTool(
            { ...operation, surface: "admin", description: "", inputSchema: {} },
            await json(c),
            () => c.db,
            c.caller,
            options.handlers as Handlers,
          ),
        };
      },
    },
    ...(metadata.developerConsole === undefined
      ? []
      : [
          {
            method: "GET",
            path: "/developer-console",
            run: (c: Context<Env, Database>) =>
              options.authorize ? visibleMetadata(c, true).then(m => m.developerConsole) : developerConsole(),
          },
        ]),
    ...(options.routes ?? []),
  ];
  const context = (
    request: Request,
    env: Env,
    caller: Caller,
    params: Record<string, string>,
    input: Record<string, unknown> | undefined,
    bound: RouteAccess,
    getDb: () => Database = () => {
      throw new Error("Only an Admin route's run acquires the database (not its target or prepare)");
    },
  ): Context<Env, Database> => {
    const c: Context<Env, Database> = {
      request,
      url: new URL(request.url),
      env,
      get db() {
        return getDb();
      },
      caller: caller as Admin,
      params,
      input,
      ...(options.authorize ? { authorize: bound.authorized } : {}),
    };
    access.set(c, bound);
    return c;
  };
  // A route's target is computed from the request alone, before authorization: it may not authorize anything itself.
  const refuse = () => Promise.reject(new Error("An Admin route's target cannot call authorize"));
  const unbound: RouteAccess = { authorize: refuse, authorized: refuse };
  const entry = (
    route: Route<Env, Database>,
    named?: { path: string; name: string; variant: string; readOnly?: boolean },
  ): RestRoute<Database, Handlers, Env> => {
    // The pattern grammar describe's matchTarget compiles from the same ids.
    const { source, keys } = routeSource(named?.path ?? route.path, ADMIN_API_BASE, true);
    const paramsOf = (params: Record<string, string>) => (named ? { ...params, name: named.name } : params);
    return {
      id: `admin:${route.method} ${route.path.replace(/\{([^}*]+)\*?\}/g, ":$1")}`,
      method: route.method,
      pattern: new RegExp(source),
      keys,
      bodyLimit: route.bodyLimit,
      rawBody: route.rawBody,
      // Every Admin read is a GET; a POST reads only through a read-only operation.
      readOnly: route.method === "GET" || named?.readOnly === true,
      variant: named?.variant,
      target:
        options.authorize && route.target
          ? (request, env, caller, params, input) =>
              route.target!(context(request, env, caller, paramsOf(params), input, unbound))
          : undefined,
      prepare: route.prepare
        ? (request, env, caller, params, input, bound) =>
            route.prepare!(context(request, env, caller, paramsOf(params), input, bound))
        : undefined,
      handle: async (request, env, getDb, caller, params, _handlers, input, bound) => {
        const result = await route.run(context(request, env, caller, paramsOf(params), input, bound, getDb));
        if (!(result instanceof Response)) return result;
        const headers = new Headers(result.headers);
        if (!route.preserveCacheControl || !headers.has("cache-control"))
          headers.set("cache-control", "private, no-store");
        return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
      },
    };
  };
  // A View or operation route is matched once per name, so a host caller's dry run and freshness follow that View
  // or Procedure (its access variant, and whether it is read-only); the template answers any other name.
  const perName: Readonly<Record<string, readonly { name: string; variant: string; readOnly?: boolean }[]>> = {
    "GET /views/{name}": views.map(v => ({ name: v.name, variant: `view:${v.name}` })),
    "GET /views/{name}/export": views.map(v => ({ name: v.name, variant: `view:${v.name}` })),
    "GET /developer/views/{name}": (options.developerViews ?? views).map(v => ({
      name: v.name,
      variant: `view:${v.name}`,
    })),
    "POST /operations/{name}": operations.map(p => ({
      name: p.name,
      variant: `procedure:${p.name}`,
      readOnly: p.readOnly === true,
    })),
  };
  const table = routes.flatMap(route => [
    ...(Object.hasOwn(perName, `${route.method} ${route.path}`)
      ? perName[`${route.method} ${route.path}`]!.map(named =>
          entry(route, { ...named, path: route.path.replace("{name}", named.name) }),
        )
      : []),
    entry(route),
  ]);
  /** Admin needs a signed-in admin session, or a gateway's admin layer. */
  const admission = (caller: Caller): Response | undefined => {
    if (caller.kind === "anonymous") throw new ContractError("UNAUTHENTICATED", "Sign in to use Admin.", "admin");
    if (isAdmin(caller) && (caller.kind === "host" || caller.credential === "session")) return undefined;
    if (options.gateway) throw new ContractError("AUTH_DENIED", "Admin layer required.", "admin");
    return Response.json(
      {
        error: { code: "AUTH_DENIED", message: "Admin needs a signed-in admin session.", path: "admin" },
        minimumRole: "admin",
      },
      { status: 403, headers: { "cache-control": "private, no-store" } },
    );
  };
  const api = nativeRest(table, {
    ...options,
    base: ADMIN_API_BASE,
    accessTargets: options.accessTargets ?? metadata.accessTargets,
    fields: options.fields ?? metadata.userFields,
    admission,
  });
  // The router loads on an Admin request only, never for the application's other paths.
  return async (request, env, ctx) => {
    const path = new URL(request.url).pathname;
    return path === ADMIN_API_BASE || path.startsWith(ADMIN_API_BASE + "/") ? api(request, env, ctx) : undefined;
  };
}
export { adminShell } from "./shell.js";
