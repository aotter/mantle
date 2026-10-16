/** One Worker fetch: Better Auth routes, Admin console + API, MCP, generated REST, then the Admin shell. */
import { authLoader, resolveCaller } from "@aotter/mantle/auth";
import { authRoutes } from "@aotter/mantle/auth/routes";
import { withAuthTasks } from "@aotter/mantle/auth/hardening";
import { checkOrigin, surfaceFailure, type Caller } from "@aotter/mantle/contracts";
import { admin, adminShell } from "@aotter/mantle-admin/server";
import { entries } from "@aotter/mantle-admin/server/entries";
import { siteRoutes } from "@aotter/mantle-admin/server/site";
import { webmcpRoutes } from "@aotter/mantle-admin/server/webmcp";
import { adminMcpApps } from "@aotter/mantle-admin/mcp";
import { mcp as serveMcp } from "@aotter/mantle/mcp";
import type { Handle } from "@aotter/mantle/driver/d1";
import { adminBindings } from "../generated/admin-bindings.js";
import { rest } from "../generated/rest.js";
import { tools } from "../generated/mcp.js";
import { mcpAppCatalogues } from "../generated/admin-descriptors.js";
import type { Handlers } from "../generated/generated.js";
import { handlers } from "./handlers.js";
import { appRoutes } from "./routes.js";

let auth: ReturnType<typeof authLoader<ReturnType<typeof import("./auth.js").createAuth>>> | undefined;
const authorities = new WeakMap<Request, () => Promise<Caller>>();
const options = { db: (env: Env) => env.DB, caller: (request: Request) => authorities.get(request)!(), handlers };
let serveAdmin: ReturnType<typeof admin<Env, Handle, Handlers>> | undefined;
let serveMcpHandler: ReturnType<typeof serveMcp<Env, Handle, Handlers>> | undefined;
const serveRest = rest(options);

export async function fetchService(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  auth ??= authLoader(() => import("./auth.js").then(m => m.createAuth(env)));
  const headers = new Headers();
  let authority: Promise<Caller> | undefined;
  // One Caller per request, resolved on first use; every surface below shares it.
  const caller = () => authority ??= resolveCaller(request, auth!, { audience: `${env.PUBLIC_ORIGIN}/mcp`, responseHeaders: headers }).then(value => { checkOrigin(request, value); return value; });
  authorities.set(request, caller);
  const respond = (response: Response) => {
    if (!headers.has("set-cookie")) return response;
    // Copy first: some responses (Response.redirect, fetched ones) have immutable headers.
    const copy = new Response(response.body, response);
    for (const cookie of headers.getSetCookie()) copy.headers.append("set-cookie", cookie);
    return copy;
  };
  try {
    const ownAuth = await withAuthTasks(context.waitUntil.bind(context), () => authRoutes(auth!, { methods: [{ kind: "email-otp" }], resolver: caller })(request));
    if (ownAuth) return respond(ownAuth);
    const url = new URL(request.url);
    const own = await appRoutes(request, env, { caller, waitUntil: context.waitUntil.bind(context) });
    if (own) return respond(own);
    let response: Response | undefined;
    if (url.pathname === "/admin/api" || url.pathname.startsWith("/admin/api/")) {
      if (!serveAdmin) {
        const bindings = adminBindings({ handlers });
        const adminOptions = { ...options, mcpEndpoints: { public: "/mcp", admin: "/mcp/admin" },
          identity: { directory: async ({ caller, request, db }: { caller: Caller; request: Request; db: Handle }) => (await import("@aotter/mantle/auth/identity")).d1Identity(db, await auth!.get(), caller, request.headers) } };
        serveAdmin = admin(bindings.metadata, bindings.views, bindings.operations, { ...adminOptions, developerViews: bindings.developerViews,
          routes: [...entries(bindings.schemas, bindings.adapter), ...siteRoutes(adminOptions), ...webmcpRoutes(bindings.metadata.webmcp, tools, handlers)] });
      }
      response = await serveAdmin(request, env);
    } else if (/^\/mcp(?:\/admin)?\/*$/.test(url.pathname)) {
      // --- MCP (optional): delete this branch with the MCP plugins in auth.ts if the app has no MCP.
      serveMcpHandler ??= serveMcp(tools, { ...options, apps: { admin: adminMcpApps({ catalogue: mcpAppCatalogues.admin }) } });
      response = await serveMcpHandler(request, env);
    } else {
      response = await serveRest(request, env);
    }
    if (response) return respond(response);
    const shell = await adminShell(request, path => env.ASSETS.fetch(new Request(new URL("/admin/" + path, url), request)));
    if (shell) return shell;
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  } catch (error) { return surfaceFailure(error); }
}
