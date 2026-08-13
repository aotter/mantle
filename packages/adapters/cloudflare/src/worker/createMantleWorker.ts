import {
  Hono,
  type Env as HonoEnv,
  type Handler,
  type MiddlewareHandler,
} from "hono";
import type {
  AnyHandler,
  CmsRuntime,
  PublicPathResolver,
  TemplateRegistry,
} from "@aotter/mantle-runtime";
import type { Manifest, SiteDefaults } from "@aotter/mantle-spec";
import {
  createConventionalAuth,
  setupIncompleteAuthResponse,
  type ConventionalAuthEnv,
} from "../auth/conventionalAuth.js";
import type { Auth } from "../auth/createAuth.js";
import {
  createConventionalBindings,
  type MantleWorkerBindings,
} from "../bindings/conventionalBindings.js";
import { createCmsRef, type CmsRuntimeRef } from "../mount/bootRuntimeOnce.js";
import type { CmsConfig } from "../mount/cmsConfig.js";
import { createMcpApiHandler } from "../mount/mountMcp.js";
import { mountServerEndpoints } from "../mount/mountServerEndpoints.js";
import type { ConsumerCredentialResolver } from "../mount/resolveCaller.js";
import { mountAuthorize } from "../oauth/mountOAuth.js";
import { OAUTH_REGISTER_PATH, OAUTH_TOKEN_PATH } from "../oauth/oauthConstants.js";
import { createOAuthProvider } from "../oauth/oauthSingleton.js";
import { PUBLIC_CACHE_TAG } from "../oauth/cachePolicy.js";

/** Fixed namespaces owned by Mantle's standard Worker surfaces. */
export const MANTLE_RESERVED_PATH_PREFIXES = [
  "/admin",
  "/api/auth",
  "/api/views",
  "/oauth",
  "/mcp",
] as const;

/** OAuth discovery paths share this prefix but not a slash boundary. */
export const MANTLE_RESERVED_WELL_KNOWN_PREFIX = "/.well-known/oauth" as const;

/** Exact registrations extensions may not claim. */
export const MANTLE_RESERVED_EXACT_PATHS = ["/favicon.svg", "*", "/*"] as const;

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
  readonly OAUTH_KV: KVNamespace;
  readonly ASSETS?: Fetcher;
}

export interface MantleWorkerBootstrapContext<Env extends MantleCloudflareEnv> {
  readonly env: Env;
  readonly auth: Auth;
  readonly bindings: MantleWorkerBindings;
  /** Safe to retain and call later; do not call synchronously inside `extend`. */
  readonly getRuntime: () => Promise<CmsRuntime>;
}

export interface MantleWorkerMountContext<Env extends MantleCloudflareEnv>
  extends MantleWorkerBootstrapContext<Env> {
  readonly app: MantleExtensionApp<Env>;
  readonly ref: CmsRuntimeRef;
}

/** The one opt-in seam for application handlers, auth inputs and routes. */
export interface MantleWorkerExtension<Env extends MantleCloudflareEnv> {
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly credentialResolver?: ConsumerCredentialResolver;
  readonly jwtBearer?: CmsConfig["jwtBearer"];
  readonly scopesSupported?: readonly string[];
  /** Standard routes mount first; extension routes may only add new paths. */
  readonly mount?: (context: MantleWorkerMountContext<Env>) => void;
}

export interface CreateMantleWorkerOptions<Env extends MantleCloudflareEnv> {
  /** Parsed manifests, normally imported from `.mantle/generated/site.js`. */
  readonly manifest: readonly Manifest[];
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults | ((env: Env) => SiteDefaults);
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
  readonly extend?: (
    context: MantleWorkerBootstrapContext<Env>,
  ) => MantleWorkerExtension<Env> | void;
}

export interface MantleWorkerHandler<Env extends MantleCloudflareEnv> {
  /** Boot and return the same runtime used by fetch. Queue/scheduled handlers
   *  use this instead of constructing a second runtime or bypassing it. */
  getRuntime(env: Env): Promise<CmsRuntime>;
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

interface AssembledWorker<Env extends MantleCloudflareEnv> {
  readonly auth: Auth;
  readonly getRuntime: () => Promise<CmsRuntime>;
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

    const conventional = createConventionalBindings(env);
    const bindings = options.bindings?.(env, conventional) ?? conventional;
    const auth = options.auth?.(env) ?? createConventionalAuth(env);
    let ref: CmsRuntimeRef | null = null;
    const getRuntime = (): Promise<CmsRuntime> => ref
      ? ref.get()
      : Promise.reject(new Error("Mantle runtime is unavailable until `extend` returns."));
    const bootstrap = { env, auth, bindings, getRuntime };
    const extension = options.extend?.(bootstrap) ?? {};

    ref = createCmsRef({
      manifests: options.manifest,
      handlers: mergeHandlers(options.handlers, extension.handlers),
      siteDefaults: resolve(options.siteDefaults, env),
      templates: options.templates,
      publicPathResolver: options.publicPathResolver,
      mediaAllowSvg: resolve(options.mediaAllowSvg, env),
      bindings,
      auth,
      credentialResolver: extension.credentialResolver,
      jwtBearer: extension.jwtBearer,
      onPublicChange: purgePublicCache,
    });

    const app = new Hono<WorkerHonoEnv<Env>>();
    mountServerEndpoints(app, ref);
    mountAuthorize(app, { auth, loginPath: "/admin/sign-in" });
    const standardRouteCount = app.routes.length;
    extension.mount?.({
      ...bootstrap,
      app: app as unknown as MantleExtensionApp<Env>,
      ref,
    });
    assertExtensionRoutes(app, standardRouteCount, auth.basePath);

    const provider = createOAuthProvider<Env>({
      defaultHandler: {
        fetch: (request, workerEnv, ctx) => app.fetch(request, workerEnv, ctx),
      },
      apiHandlers: {
        "/mcp/staff": createMcpApiHandler<Env>({ ref, surface: "staff" }),
        "/mcp": createMcpApiHandler<Env>({ ref, surface: "public" }),
      },
      scopesSupported: [...new Set(["mcp", ...(extension.scopesSupported ?? [])])],
    });
    const next: AssembledWorker<Env> = {
      auth,
      getRuntime,
      fetch: (request, workerEnv, ctx) => provider.fetch(request, workerEnv, ctx),
    };
    assembled = next;
    return next;
  };

  return {
    getRuntime(env) {
      return assemble(env).getRuntime();
    },
    async fetch(request, env, ctx) {
      return runMantleWorkerRequest(async () => {
        const worker = assemble(env);
        const setupIncomplete = await setupIncompleteAuthResponse(request, worker.auth);
        if (setupIncomplete) return setupIncomplete;
        if (!isRuntimeIndependentOAuthRequest(request)) await worker.getRuntime();
        return worker.fetch(request, env, ctx);
      });
    },
  };
}

async function purgePublicCache(): Promise<void> {
  const { cache } = await import("cloudflare:workers");
  // Miniflare does not simulate entrypoint caching or its purge API.
  if (typeof cache.purge !== "function") return;
  const result = await cache.purge({ tags: [PUBLIC_CACHE_TAG] });
  if (!result.success) {
    console.error("Mantle public cache purge failed", result.errors);
  }
}

function isRuntimeIndependentOAuthRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (
    pathname === OAUTH_TOKEN_PATH ||
    pathname === OAUTH_REGISTER_PATH ||
    pathname.startsWith(MANTLE_RESERVED_WELL_KNOWN_PREFIX)
  ) return true;
  return (pathname === "/mcp" || pathname.startsWith("/mcp/")) &&
    !request.headers.has("authorization");
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
    if (isReservedPath(route.path, authBasePath)) {
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

function isReservedPath(path: string, authBasePath: string): boolean {
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
