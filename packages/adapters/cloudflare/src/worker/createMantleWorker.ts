import {
  Hono,
  type Env as HonoEnv,
  type Handler,
  type MiddlewareHandler,
} from "hono";
import type {
  AnyHandler,
  RuntimePlan,
} from "@aotter/mantle-runtime";
import type { PublicPathResolver, TemplateRegistry } from "@aotter/mantle-web";
import { createRuntimeClient } from "@aotter/mantle-web/client-runtime";
import type { SiteDefaults } from "@aotter/mantle-spec";
import { mountMantleOAuth } from "@aotter/mantle-admin";
import {
  conventionalMcpResource,
  createConventionalAuth,
  setupIncompleteAuthResponse,
  type ConventionalAuthEnv,
} from "../auth/conventionalAuth.js";
import type { Auth } from "../auth/createAuth.js";
import {
  createConventionalBindings,
  type MantleWorkerBindings,
} from "../bindings/conventionalBindings.js";
import {
  createMantleRuntimeRef,
  type CloudflareMantleRuntime,
  type MantleRuntimeRef,
} from "../mount/bootRuntimeOnce.js";
import type { MantleCloudflareConfig } from "../mount/cmsConfig.js";
import { createMcpApiHandler } from "../mount/mountMcp.js";
import { mountAdmin } from "../mount/mountAdmin.js";
import { withFrontendCors } from "../mount/frontendCors.js";
import { mountRuntimeEndpoints } from "../mount/mountRuntimeEndpoints.js";
import { resolveCaller, type ConsumerCredentialResolver } from "../mount/resolveCaller.js";
import {
  applyCachePolicy,
  normalizeCacheScope,
  scopedPublicCacheTag,
} from "../oauth/cachePolicy.js";

/** Fixed namespaces owned by Mantle's standard Worker surfaces. */
export const MANTLE_RESERVED_PATH_PREFIXES = [
  "/admin",
  "/_mantle",
  "/api/auth",
  "/api/views",
  "/oauth",
  "/mcp",
] as const;

/** OAuth discovery paths share this prefix but not a slash boundary. */
export const MANTLE_RESERVED_WELL_KNOWN_PREFIX = "/.well-known/oauth" as const;

/** Exact registrations extensions may not claim. */
export const MANTLE_RESERVED_EXACT_PATHS = ["*", "/*"] as const;

type ReservedPrefix = (typeof MANTLE_RESERVED_PATH_PREFIXES)[number];
type ReservedExact = (typeof MANTLE_RESERVED_EXACT_PATHS)[number];
type ReservedPath =
  | ReservedExact
  | ReservedPrefix
  | `${ReservedPrefix}${"/" | "*" | "{"}${string}`
  | `${typeof MANTLE_RESERVED_WELL_KNOWN_PREFIX}${string}`;

/** Static literals under Core-owned paths fail during consumer typecheck/build. */
export type MantleExtensionPath<Path extends string> = string extends Path
  ? Path
  : Path extends ReservedPath
    ? never
    : Path;

type WorkerHonoEnv<Bindings extends object> = { Bindings: Bindings };
type ExtensionHandler<Bindings extends object, Path extends string> =
  | Handler<WorkerHonoEnv<Bindings>, Path>
  | MiddlewareHandler<WorkerHonoEnv<Bindings>, Path>;
type SafePath<Path extends string> = Path & MantleExtensionPath<Path>;
type ExtensionRoute<Bindings extends object> = <const Path extends string>(
  path: SafePath<Path>,
  ...handlers: [ExtensionHandler<Bindings, Path>, ...ExtensionHandler<Bindings, Path>[]]
) => MantleExtensionApp<Bindings>;

/**
 * A restricted view of the real Hono app. It keeps Hono handlers and routing,
 * but omits global error/not-found hooks and rejects literal reserved paths.
 */
export interface MantleExtensionApp<Bindings extends object> {
  readonly get: ExtensionRoute<Bindings>;
  readonly post: ExtensionRoute<Bindings>;
  readonly put: ExtensionRoute<Bindings>;
  readonly patch: ExtensionRoute<Bindings>;
  readonly delete: ExtensionRoute<Bindings>;
  readonly options: ExtensionRoute<Bindings>;
  readonly all: ExtensionRoute<Bindings>;
  on<const Path extends string>(
    method: string | readonly string[],
    path: SafePath<Path>,
    ...handlers: [ExtensionHandler<Bindings, Path>, ...ExtensionHandler<Bindings, Path>[]]
  ): MantleExtensionApp<Bindings>;
  use<const Path extends string>(
    path: SafePath<Path>,
    ...handlers: [MiddlewareHandler<WorkerHonoEnv<Bindings>, Path>, ...MiddlewareHandler<WorkerHonoEnv<Bindings>, Path>[]]
  ): MantleExtensionApp<Bindings>;
  route<const Path extends string, SubEnv extends HonoEnv>(
    path: SafePath<Path>,
    app: Hono<SubEnv>,
  ): MantleExtensionApp<Bindings>;
}

export interface MantleCloudflareEnv extends ConventionalAuthEnv {
  readonly ASSETS?: Fetcher;
  /** Optional derived MCP catalog snapshot. D1 remains canonical. */
  readonly MANTLE_KV?: KVNamespace;
}

export interface MantleWorkerBootstrapContext<Env extends MantleCloudflareEnv> {
  readonly env: Env;
  readonly auth: Auth;
  readonly bindings: MantleWorkerBindings;
  /** Safe to retain and call later; do not call synchronously inside `extend`. */
  readonly getRuntime: () => Promise<CloudflareMantleRuntime>;
}

export interface MantleWorkerMountContext<Env extends MantleCloudflareEnv>
  extends MantleWorkerBootstrapContext<Env> {
  readonly app: MantleExtensionApp<Env>;
  readonly ref: MantleRuntimeRef;
}

/** The one opt-in seam for application handlers, auth inputs and routes. */
export interface MantleWorkerExtension<Env extends MantleCloudflareEnv> {
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly credentialResolver?: ConsumerCredentialResolver;
  readonly jwtBearer?: MantleCloudflareConfig["jwtBearer"];
  /** Standard routes mount first; extension routes may only add new paths. */
  readonly mount?: (context: MantleWorkerMountContext<Env>) => void;
}

export interface CreateMantleWorkerOptions<Env extends MantleCloudflareEnv> {
  /** Sealed generated plan imported from `.mantle/generated/mantle.js`. */
  readonly plan: RuntimePlan;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults | ((env: Env) => SiteDefaults);
  /** Stable deployment/site identifier used by public cache tags and optional KV. */
  readonly cacheScope?: string | ((env: Env) => string);
  /** Exact external browser origins. Never grants a principal or cookie access. */
  readonly frontendOrigins?: readonly string[] | ((env: Env) => readonly string[]);
  /** Fallback for app-owned paths after native routes; one authorized client per request. */
  readonly frontend?: (request: Request, context: {
    readonly env: Env;
    readonly client: ReturnType<typeof createRuntimeClient>;
    readonly executionCtx: ExecutionContext;
  }) => Response | Promise<Response>;
  readonly templates?: TemplateRegistry;
  readonly publicPathResolver?: PublicPathResolver;
  readonly mediaAllowSvg?: boolean | ((env: Env) => boolean);
  /** Replace only Auth construction; standard Auth routes remain Core-owned. */
  readonly auth?: (env: Env) => Auth;
  /** Augment conventional adapters for a proven capability such as R2 media. */
  readonly bindings?: (
    env: Env,
    conventional: MantleWorkerBindings,
  ) => MantleWorkerBindings;
  /** May rerun after initialization fails; keep external side effects out of assembly. */
  readonly extend?: (
    context: MantleWorkerBootstrapContext<Env>,
  ) => MantleWorkerExtension<Env> | void;
}

export interface MantleWorkerHandler<Env extends MantleCloudflareEnv> {
  /** Boot and return the same runtime used by fetch. Queue/scheduled handlers
   *  use this instead of constructing a second runtime or bypassing it. */
  getRuntime(env: Env): Promise<CloudflareMantleRuntime>;
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

interface AssembledWorker<Env extends MantleCloudflareEnv> {
  readonly auth: Auth;
  readonly getRuntime: () => Promise<CloudflareMantleRuntime>;
  readonly fetch: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<Response>;
}

/** Assemble Mantle's conventional Worker once per isolate. */
export function createMantleWorker<Env extends MantleCloudflareEnv = MantleCloudflareEnv>(
  options: CreateMantleWorkerOptions<Env>,
): MantleWorkerHandler<Env> {
  let assembled: AssembledWorker<Env> | null = null;

  const assemble = (env: Env): AssembledWorker<Env> => {
    if (assembled) return assembled;

    const cacheScope = normalizeCacheScope(resolve(options.cacheScope, env));
    const publicCacheTag = scopedPublicCacheTag(cacheScope);
    const conventional = createConventionalBindings(env, cacheScope);
    const bindings = options.bindings?.(env, conventional) ?? conventional;
    const auth = options.auth?.(env) ?? createConventionalAuth(env);
    let ref: MantleRuntimeRef | null = null;
    const getRuntime = (): Promise<CloudflareMantleRuntime> => ref
      ? ref.get()
      : Promise.reject(new Error("Mantle runtime is unavailable until `extend` returns."));
    const bootstrap = { env, auth, bindings, getRuntime };
    const extension = options.extend?.(bootstrap) ?? {};
    const sharedPublicCacheTag = extension.credentialResolver ? undefined : publicCacheTag;

    ref = createMantleRuntimeRef({
      plan: options.plan,
      handlers: mergeHandlers(options.handlers, extension.handlers),
      siteDefaults: resolve(options.siteDefaults, env),
      cacheScope: sharedPublicCacheTag ? cacheScope : undefined,
      templates: options.templates,
      publicPathResolver: options.publicPathResolver,
      reservedHttpPathPrefixes: [
        ...MANTLE_RESERVED_PATH_PREFIXES,
        MANTLE_RESERVED_WELL_KNOWN_PREFIX,
        auth.basePath,
      ],
      mediaAllowSvg: resolve(options.mediaAllowSvg, env),
      bindings,
      auth,
      credentialResolver: extension.credentialResolver,
      jwtBearer: extension.jwtBearer,
      onPublicChange: () => purgePublicCache(sharedPublicCacheTag),
    });

    const app = new Hono<WorkerHonoEnv<Env>>();
    // Preserve Hono HTTP responses; redact unexpected failures at the facade.
    app.onError((error, c) => {
      if ("getResponse" in error) {
        const response = error.getResponse();
        return c.newResponse(response.body, response);
      }
      throw error;
    });
    // Schema readiness belongs to database consumers, not static dispatch.
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (hasOwnedPrefix(path, auth.basePath)
        || hasOwnedPrefix(path, "/oauth")
        || hasOwnedPrefix(path, "/mcp")
        || hasOwnedPrefix(path, "/admin/api")
        || path.startsWith(MANTLE_RESERVED_WELL_KNOWN_PREFIX)) {
        await getRuntime();
      }
      await next();
    });
    mountRuntimeEndpoints(app, ref);
    if (bindings.adminAssets) mountAdmin(app, ref, bindings.adminAssets);
    mountMantleOAuth(app, { auth, assets: bindings.adminAssets });
    const mcpResource = auth.mcpResource ?? conventionalMcpResource(env);
    const publicMcp = createMcpApiHandler<Env>({
      ref,
      surface: "public",
      resource: mcpResource,
    });
    const staffMcp = createMcpApiHandler<Env>({
      ref,
      surface: "staff",
      resource: mcpResource,
    });
    app.all("/mcp", (c) => publicMcp.fetch!(
      c.req.raw as Parameters<NonNullable<typeof publicMcp.fetch>>[0],
      c.env,
      c.executionCtx as Parameters<NonNullable<typeof publicMcp.fetch>>[2],
    ));
    app.all("/mcp/staff", (c) => staffMcp.fetch!(
      c.req.raw as Parameters<NonNullable<typeof staffMcp.fetch>>[0],
      c.env,
      c.executionCtx as Parameters<NonNullable<typeof staffMcp.fetch>>[2],
    ));
    const standardRouteCount = app.routes.length;
    extension.mount?.({
      ...bootstrap,
      app: app as unknown as MantleExtensionApp<Env>,
      ref,
    });
    assertExtensionRoutes(app, standardRouteCount, auth.basePath);

    // A convention, not a reserved namespace: an existing host route wins.
    app.get("/favicon.ico", async (c) => {
      const icons = (await (await ref!.get()).siteConfig.load()).icons;
      const icon = icons.find((candidate) => candidate.mimeType === "image/png" && !candidate.theme)
        ?? icons.find((candidate) => !candidate.theme)
        ?? icons[0];
      if (!icon) return c.notFound();
      const target = new URL(icon.src, c.req.url);
      if (target.origin === new URL(c.req.url).origin && target.pathname === "/favicon.ico") {
        return await bindings.adminAssets?.fetch(new Request(target)) ?? c.notFound();
      }
      return c.redirect(icon.src);
    });

    if (options.frontend) app.notFound(async c => {
      if (isMantleReservedPath(c.req.path, auth.basePath) || hasOwnedPrefix(c.req.path, "/api")) return new Response("Not found", { status: 404 });
      const request = c.req.raw;
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.has("cookie") && !request.headers.has("authorization") && request.headers.get("origin") !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
      const caller = await resolveCaller(request, { auth, env: c.env, credentialResolver: extension.credentialResolver, jwtBearer: extension.jwtBearer, waitUntil: promise => c.executionCtx.waitUntil(promise) });
      if (caller.kind === "invalid") return Response.json({ ok: false, diagnostic: caller.diagnostic }, { status: caller.status });
      return options.frontend!(request, { env: c.env, executionCtx: c.executionCtx as ExecutionContext,
        client: createRuntimeClient({ origin: new URL(request.url).origin, plan: options.plan, getRuntime, context: caller.context }) });
    });

    const next: AssembledWorker<Env> = {
      auth,
      getRuntime,
      fetch: async (request, workerEnv, ctx) =>
        applyCachePolicy(request, await app.fetch(request, workerEnv, ctx), sharedPublicCacheTag ?? null),
    };
    assembled = next;
    void auth.ready?.catch(() => {
      if (assembled === next) assembled = null;
    });
    return next;
  };

  return {
    async getRuntime(env) {
      const worker = assemble(env);
      const [runtime] = await Promise.all([worker.getRuntime(), worker.auth.ready]);
      return runtime;
    },
    async fetch(request, env, ctx) {
      return runMantleWorkerRequest(async () => {
        const worker = assemble(env);
        if (worker.auth.ready) ctx.waitUntil(worker.auth.ready);
        const setupIncomplete = await setupIncompleteAuthResponse(request, worker.auth);
        if (setupIncomplete) return setupIncomplete;
        const origins = resolve(options.frontendOrigins, env);
        const pathname = new URL(request.url).pathname;
        return origins && (pathname.startsWith("/api/") || pathname.startsWith(MANTLE_RESERVED_WELL_KNOWN_PREFIX))
          ? withFrontendCors(request, origins, () => worker.fetch(request, env, ctx))
          : worker.fetch(request, env, ctx);
      });
    },
  };
}

async function purgePublicCache(publicCacheTag: string | undefined): Promise<void> {
  if (!publicCacheTag) return;
  const { cache } = await import("cloudflare:workers");
  // Miniflare does not simulate entrypoint caching or its purge API.
  if (typeof cache.purge !== "function") return;
  const result = await cache.purge({ tags: [publicCacheTag] });
  if (!result.success) {
    console.error("Mantle public cache purge failed", result.errors);
  }
}

/** Redacted fail-closed boundary for facade and low-level Worker assembly failures. */
export async function runMantleWorkerRequest(
  run: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error("[mantle] Worker request failed", error);
    return Response.json(
      { ok: false, error: "internal_error" },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    );
  }
}

function assertExtensionRoutes<Env extends object>(
  app: Hono<WorkerHonoEnv<Env>>,
  standardRouteCount: number,
  authBasePath: string,
): void {
  const standard = app.routes.slice(0, standardRouteCount);
  for (const route of app.routes.slice(standardRouteCount)) {
    if (isMantleReservedPath(route.path, authBasePath)) {
      throw new Error(`Mantle extension route '${route.path}' is reserved by Core.`);
    }
    const duplicate = standard.some(
      (owned) => owned.path === route.path && methodsOverlap(owned.method, route.method),
    );
    if (duplicate) {
      throw new Error(`Mantle extension route '${route.method} ${route.path}' duplicates a Core route.`);
    }
  }
}

export function isMantleReservedPath(path: string, authBasePath = "/api/auth"): boolean {
  return MANTLE_RESERVED_EXACT_PATHS.some((owned) => path === owned)
    || MANTLE_RESERVED_PATH_PREFIXES.some((owned) => hasOwnedPrefix(path, owned))
    || path.startsWith(MANTLE_RESERVED_WELL_KNOWN_PREFIX)
    || hasOwnedPrefix(path, authBasePath);
}

function hasOwnedPrefix(path: string, prefix: string): boolean {
  return path === prefix
    || path.startsWith(`${prefix}/`)
    || path.startsWith(`${prefix}*`)
    || path.startsWith(`${prefix}{`);
}

function methodsOverlap(left: string, right: string): boolean {
  return left === "ALL" || right === "ALL" || left === right;
}

function mergeHandlers(
  base: Readonly<Record<string, AnyHandler>> | undefined,
  extra: Readonly<Record<string, AnyHandler>> | undefined,
): Readonly<Record<string, AnyHandler>> | undefined {
  if (!base) return extra;
  if (!extra) return base;
  for (const key of Object.keys(extra)) {
    if (Object.hasOwn(base, key)) {
      throw new Error(`Mantle handler '${key}' is registered twice.`);
    }
  }
  return { ...base, ...extra };
}

function resolve<Value, Env>(
  value: Value | ((env: Env) => Value) | undefined,
  env: Env,
): Value | undefined {
  return typeof value === "function"
    ? (value as (input: Env) => Value)(env)
    : value;
}
