// Written once by `mantle generate`; this file is yours now. It composes the service (ADR-0032 decision 6).
import { createMantle, withCaller, type MantleRuntime, type MantleService, type Surface } from "@aotter/mantle";
import { createAdminSurface } from "@aotter/mantle/admin";
import { ConsoleEmailSender, createAuthRoutes, createCallerResolver, createMantleAuth, createSetupIncompleteAuth, type MantleAuth } from "@aotter/mantle/auth";
import { d1Driver, d1Storage } from "@aotter/mantle/cloudflare";
import { createMcpSurface, planApp } from "@aotter/mantle/mcp";
import { mantleAppHtml } from "@aotter/mantle-ui/mcp-app";
import { createRestSurface } from "@aotter/mantle/web";
import { plan } from "../.mantle/generated/mantle.js";
import { handlers } from "./handlers.js";

export interface Env {
  readonly DB: D1Database;
  /** The Admin SPA's files (`@aotter/mantle-ui/admin`), bound in wrangler.jsonc. */
  readonly ASSETS: Fetcher;
  readonly BETTER_AUTH_SECRET?: string;
  readonly PUBLIC_ORIGIN?: string;
  readonly ADMIN_EMAIL?: string;
}

/** One-time codes printed to the log are for local development: a deployed service picks its own sign-in method and sender. */
function createAuth(env: Env, origin: string): MantleAuth {
  // an unset PUBLIC_ORIGIN is not local: the fallback origin below is only for URLs, never for deciding to print codes
  const local = env.PUBLIC_ORIGIN !== undefined && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  if (!local || !env.BETTER_AUTH_SECRET || !env.ADMIN_EMAIL)
    return createSetupIncompleteAuth({ message: "Sign-in is not configured: copy .dev.vars.example to .dev.vars locally, or choose a sign-in method in src/service.ts." });
  return createMantleAuth({
    database: env.DB, driver: d1Driver(env.DB), baseURL: origin, secret: env.BETTER_AUTH_SECRET,
    methods: [{ kind: "email-otp", sender: new ConsoleEmailSender() }],
    bootstrapOwner: { match: "email", value: env.ADMIN_EMAIL },
    ipAddressHeaders: ["cf-connecting-ip"],
    oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: `${origin}/mcp` },
  });
}

/** A file of the Admin SPA, or null when it has none by that path. */
async function adminAsset(assets: Fetcher, path: string): Promise<Response | null> {
  const response = await assets.fetch(new URL(path, "http://assets/"));
  return response.ok ? response : null;
}

function mount(runtime: MantleRuntime, env: Env) {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "") ?? "http://127.0.0.1:8787";
  const auth = createAuth(env, origin);
  const resolver = createCallerResolver(auth, { jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] } });
  const authRoutes = createAuthRoutes(auth, { resolver });
  const guard = (surface: Surface, options?: { resourceMetadata?: string }) => withCaller(resolver, surface, options);
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const admin = guard(createAdminSurface(runtime, { basePath: "/admin", assets: (path) => adminAsset(env.ASSETS, path), identity: { directory: auth, roles: auth, deleteUser: auth.deleteUser }, site: { mcpEndpoints: { public: "/mcp", staff: "/mcp/staff" } } }));
  const mcp = guard(createMcpSurface(runtime, { basePath: "/mcp", surface: "public", resourceMetadata }), { resourceMetadata });
  // MCP Apps hosts render each staff View's rows, and the operations on one row, in the chat
  const staffMcp = guard(createMcpSurface(runtime, { basePath: "/mcp/staff", surface: "staff", apps: { resources: [planApp(runtime.plan, { surface: "staff", html: mantleAppHtml })] }, resourceMetadata }), { resourceMetadata });
  // REST answers everything else: public Views under /api/views and the plan's HTTP Triggers
  const rest = guard(createRestSurface(runtime, { basePath: "/api" }));
  return async (request: Request, waitUntil: (promise: Promise<unknown>) => void): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    // Better Auth's context is per isolate: the request that starts it waits for it, or the next one hangs on it; a failed start is mounted again
    await auth.ready?.catch((error) => {
      routes = undefined;
      throw error;
    });
    const owned = await authRoutes(request, { waitUntil });
    if (owned) return owned;
    if (under("/admin")) return admin(request);
    if (under("/mcp/staff")) return staffMcp(request);
    if (under("/mcp")) return mcp(request);
    return rest(request);
  };
}

let routes: ReturnType<typeof mount> | undefined;
const service: MantleService<Env> = {
  handlers,
  fetch: (request, env, { runtime, waitUntil }) => (routes ??= mount(runtime, env))(request, waitUntil),
};

export const mantle = createMantle(service, { plan, storage: (env) => d1Storage(env.DB), schedules: true });
