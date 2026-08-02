import { Hono } from "hono";
import type {
  AnyHandler,
  CmsRuntime,
  PublicPathResolver,
  TemplateRegistry,
} from "@aotter/mantle-runtime";
import type {
  Manifest,
  SiteDefaults,
} from "@aotter/mantle-spec";
import {
  createAuth,
  createSetupIncompleteAuth,
  isSetupIncompleteAuth,
  type Auth,
  type AuthMethodConfig,
} from "../auth/createAuth.js";
import {
  AssetsAssetServer,
  D1DatabaseDriver,
  KvCacheBinding,
} from "../bindings/index.js";
import { createCmsRef, type CmsRuntimeRef } from "../mount/bootRuntimeOnce.js";
import type { CmsConfig } from "../mount/cmsConfig.js";
import { createMcpApiHandler } from "../mount/mountMcp.js";
import { mountServerEndpoints } from "../mount/mountServerEndpoints.js";
import type { ConsumerCredentialResolver } from "../mount/resolveCaller.js";
import { mountAuthorize } from "../oauth/mountOAuth.js";
import { createOAuthProvider } from "../oauth/oauthSingleton.js";

const AUTH_NOT_CONFIGURED =
  "Admin auth is not configured yet. Configure Mantle hosted auth or self-managed GitHub OAuth.";
const PLATFORM_AUTH_PROVIDER_ID = "mantle-platform";

/** Conventional bindings and environment metadata used by the default façade. */
export interface MantleCloudflareEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly OAUTH_KV: KVNamespace;
  readonly ASSETS?: Fetcher;
  readonly PUBLIC_ORIGIN?: string;
  readonly MANTLE_SITE_BRAND?: string;
  readonly MANTLE_SITE_DESCRIPTION?: string;
  /** BCP 47 locale strings; a JSON string remains accepted for legacy TOML vars. */
  readonly MANTLE_SITE_LOCALES?: readonly string[] | string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly MANTLE_PLATFORM_AUTH_ISSUER?: string;
  readonly MANTLE_PLATFORM_AUTH_CLIENT_ID?: string;
  readonly MANTLE_PLATFORM_AUTH_CLIENT_SECRET?: string;
  readonly MANTLE_SITE_OWNER_EMAIL?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly ADMIN_GITHUB_LOGIN?: string;
}

export type MantleWorkerBindings = CmsConfig["bindings"];

/** Context available while an opt-in extension is assembled once per isolate. */
export interface MantleWorkerBootstrapContext<Env extends MantleCloudflareEnv> {
  readonly env: Env;
  readonly auth: Auth;
  readonly bindings: MantleWorkerBindings;
  /** Safe to retain and call later; do not call synchronously from `extend`. */
  readonly getRuntime: () => Promise<CmsRuntime>;
}

/** Context used to add application-owned routes or middleware to Mantle's router. */
export interface MantleWorkerMountContext<Env extends MantleCloudflareEnv>
  extends MantleWorkerBootstrapContext<Env> {
  readonly app: Hono<{ Bindings: Env }>;
  readonly ref: CmsRuntimeRef;
}

/**
 * The single opt-in seam between the minimal façade and full low-level assembly.
 * It deliberately exposes the real Core-owned router/runtime/Auth/bindings instead
 * of inventing a second routing or data-access DSL.
 */
export interface MantleWorkerExtension<Env extends MantleCloudflareEnv> {
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly credentialResolver?: ConsumerCredentialResolver;
  readonly oauthBearer?: CmsConfig["oauthBearer"];
  readonly scopesSupported?: readonly string[];
  /** Register middleware or deliberate route overrides before standard mounts. */
  readonly beforeMount?: (context: MantleWorkerMountContext<Env>) => void;
  /** Register normal application routes after Mantle's standard mounts. */
  readonly mount?: (context: MantleWorkerMountContext<Env>) => void;
}

export interface CreateMantleWorkerOptions<Env extends MantleCloudflareEnv> {
  /** Parsed manifests, normally imported from `.mantle/generated/site.ts`. */
  readonly manifest: readonly Manifest[];
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults | ((env: Env) => SiteDefaults);
  readonly templates?: TemplateRegistry;
  readonly publicPathResolver?: PublicPathResolver;
  readonly mediaAllowSvg?: boolean | ((env: Env) => boolean);
  /** Replace only the auth factory; all standard auth routes remain Core-owned. */
  readonly auth?: (env: Env) => Auth;
  /** Augment the required conventional D1/KV/assets adapters. Use the public
   *  low-level assembly path for a deployment with a different architecture. */
  readonly bindings?: (
    env: Env,
    conventional: MantleWorkerBindings,
  ) => MantleWorkerBindings;
  readonly extend?: (
    context: MantleWorkerBootstrapContext<Env>,
  ) => MantleWorkerExtension<Env> | void;
}

interface AssembledWorker<Env extends MantleCloudflareEnv> {
  readonly auth: Auth;
  readonly fetch: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<Response>;
}

/** Mantle's façade always supplies a fetch handler. Other Worker events can
 * delegate to it without weakening the type to an optional callback. */
export interface MantleWorkerHandler<Env extends MantleCloudflareEnv> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/**
 * Assemble the standard Mantle Worker once per isolate. The default path owns
 * bindings, Auth, Admin/REST/Trigger routes, OAuth and public/staff MCP. Advanced
 * consumers can extend this same stack or keep composing the exported low-level
 * primitives directly.
 */
export function createMantleWorker<Env extends MantleCloudflareEnv = MantleCloudflareEnv>(
  options: CreateMantleWorkerOptions<Env>,
): MantleWorkerHandler<Env> {
  let assembled: AssembledWorker<Env> | null = null;

  const assemble = (env: Env): AssembledWorker<Env> => {
    if (assembled) return assembled;

    const auth = options.auth?.(env) ?? createConventionalAuth(env);
    const conventional = conventionalBindings(env);
    const bindings = options.bindings?.(env, conventional) ?? conventional;
    let ref: CmsRuntimeRef | null = null;
    const getRuntime = (): Promise<CmsRuntime> => {
      if (!ref) {
        return Promise.reject(
          new Error("Mantle runtime is not assembled until the extension factory returns."),
        );
      }
      return ref.get();
    };
    const bootstrap = { env, auth, bindings, getRuntime };
    const extension = options.extend?.(bootstrap) ?? {};

    ref = createCmsRef({
      manifests: options.manifest,
      handlers: mergeHandlers(options.handlers, extension.handlers),
      siteDefaults: resolveSiteDefaults(options.siteDefaults, env),
      templates: options.templates,
      publicPathResolver: options.publicPathResolver,
      mediaAllowSvg: typeof options.mediaAllowSvg === "function"
        ? options.mediaAllowSvg(env)
        : options.mediaAllowSvg,
      bindings,
      auth,
      credentialResolver: extension.credentialResolver,
      oauthBearer: extension.oauthBearer,
    });

    const app = new Hono<{ Bindings: Env }>();
    const mountContext = { ...bootstrap, app, ref };
    extension.beforeMount?.(mountContext);
    mountServerEndpoints(app, ref);
    mountAuthorize(app, { auth, loginPath: "/admin/sign-in" });
    extension.mount?.(mountContext);

    const provider = createOAuthProvider<Env>({
      defaultHandler: { fetch: (request, workerEnv, ctx) => app.fetch(request, workerEnv, ctx) },
      apiHandlers: {
        "/mcp/staff": createMcpApiHandler<Env>({ ref, surface: "staff" }),
        "/mcp": createMcpApiHandler<Env>({ ref, surface: "public" }),
      },
      scopesSupported: [...new Set(["mcp", ...(extension.scopesSupported ?? [])])],
    });

    const next: AssembledWorker<Env> = {
      auth,
      fetch: (request, workerEnv, ctx) => provider.fetch(request, workerEnv, ctx),
    };
    assembled = next;
    return next;
  };

  return {
    async fetch(request, env, ctx) {
      return runMantleWorkerRequest(async () => {
        const worker = assemble(env);
        const setupIncomplete = await setupIncompleteAuthResponse(request, worker.auth);
        if (setupIncomplete) return setupIncomplete;
        return await worker.fetch(request, env, ctx);
      });
    },
  };
}

/** Shared fail-closed request boundary for façade and low-level compositions. */
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

function conventionalBindings(env: MantleCloudflareEnv): MantleWorkerBindings {
  if (!env.DB) throw new Error("Mantle requires the conventional DB binding.");
  if (!env.KV) throw new Error("Mantle requires the conventional KV binding.");
  if (!env.OAUTH_KV) throw new Error("Mantle requires the conventional OAUTH_KV binding.");
  return {
    db: new D1DatabaseDriver(env.DB),
    kv: new KvCacheBinding(env.KV),
    assets: env.ASSETS
      ? new AssetsAssetServer(env.ASSETS)
      : { fetch: async () => null },
  };
}

function createConventionalAuth(env: MantleCloudflareEnv): Auth {
  const baseURL = env.PUBLIC_ORIGIN?.trim() || "http://localhost:8787";
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const issuer = normalizedPlatformIssuer(env.MANTLE_PLATFORM_AUTH_ISSUER);
  const hostedReady = Boolean(
    secret && issuer && env.MANTLE_PLATFORM_AUTH_CLIENT_ID && env.MANTLE_SITE_OWNER_EMAIL,
  );
  const githubReady = Boolean(
    secret && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.ADMIN_GITHUB_LOGIN,
  );
  if (!hostedReady && !githubReady) {
    return createSetupIncompleteAuth({
      message: AUTH_NOT_CONFIGURED,
      response: setupIncompleteResponse,
    });
  }

  const methods: AuthMethodConfig[] = hostedReady
    ? [{
        kind: "oauth",
        providerId: PLATFORM_AUTH_PROVIDER_ID,
        displayName: "Mantle Platform",
        clientId: env.MANTLE_PLATFORM_AUTH_CLIENT_ID!,
        ...(env.MANTLE_PLATFORM_AUTH_CLIENT_SECRET
          ? { clientSecret: env.MANTLE_PLATFORM_AUTH_CLIENT_SECRET }
          : {}),
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        issuer: issuer!,
        requireIssuerValidation: true,
        scopes: ["openid", "profile", "email"],
        redirectURI: `${baseURL}/api/auth/oauth2/callback/${PLATFORM_AUTH_PROVIDER_ID}`,
        pkce: true,
      }]
    : [{
        kind: "social",
        provider: "github",
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
      }];

  return createAuth({
    database: env.DB,
    baseURL,
    secret: secret!,
    methods,
    bootstrapOwner: hostedReady
      ? { match: "email", value: env.MANTLE_SITE_OWNER_EMAIL! }
      : { match: "github-login", value: env.ADMIN_GITHUB_LOGIN! },
  });
}

function normalizedPlatformIssuer(value: string | undefined): string | null {
  const issuer = value?.trim().replace(/\/+$/, "");
  if (!issuer) return null;
  return issuer.endsWith("/api/auth") ? issuer : `${issuer}/api/auth`;
}

function resolveSiteDefaults<Env extends MantleCloudflareEnv>(
  configured: CreateMantleWorkerOptions<Env>["siteDefaults"],
  env: Env,
): SiteDefaults {
  if (typeof configured === "function") return configured(env);
  if (configured) return configured;
  return {
    brand: env.MANTLE_SITE_BRAND?.trim() || undefined,
    title: env.MANTLE_SITE_BRAND?.trim() || undefined,
    description: env.MANTLE_SITE_DESCRIPTION?.trim() || undefined,
    origin: env.PUBLIC_ORIGIN?.trim() || "http://localhost:8787",
    locales: parseLocales(env.MANTLE_SITE_LOCALES),
  };
}

function parseLocales(raw: readonly string[] | string | undefined): readonly string[] {
  let parsed: unknown = raw;
  if (raw === undefined) return ["en"];
  if (typeof raw === "string") {
    if (!raw.trim()) return ["en"];
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("MANTLE_SITE_LOCALES must be a non-empty JSON array of locale strings.");
    }
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((locale) => typeof locale !== "string" || !locale.trim())
  ) {
    throw new Error("MANTLE_SITE_LOCALES must be a non-empty JSON array of locale strings.");
  }
  return parsed;
}

function mergeHandlers(
  base: Readonly<Record<string, AnyHandler>> | undefined,
  extra: Readonly<Record<string, AnyHandler>> | undefined,
): Readonly<Record<string, AnyHandler>> | undefined {
  if (!base) return extra;
  if (!extra) return base;
  for (const key of Object.keys(extra)) {
    if (Object.hasOwn(base, key)) throw new Error(`Mantle handler '${key}' is registered twice.`);
  }
  return { ...base, ...extra };
}

/** Apply the same fail-closed first-deploy guard used by the façade.
 * Low-level Worker compositions should call this before their router. */
export async function setupIncompleteAuthResponse(
  request: Request,
  auth: Auth,
): Promise<Response | null> {
  if (!isSetupIncompleteAuth(auth) || !isAuthProtectedPath(request, auth)) return null;
  return privateResponse(await auth.handler(request));
}

function isAuthProtectedPath(request: Request, auth: Auth): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === auth.basePath ||
    pathname.startsWith(`${auth.basePath}/`) ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/register" ||
    pathname.startsWith("/.well-known/oauth") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/")
  );
}

function setupIncompleteResponse(): Response {
  return Response.json(
    { error: "setup_incomplete", message: AUTH_NOT_CONFIGURED },
    { status: 503, headers: { "cache-control": "private, no-store" } },
  );
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.delete("cdn-cache-control");
  headers.delete("cloudflare-cdn-cache-control");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}
