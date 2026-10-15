import { authLoader, resolveCaller } from "@aotter/mantle/auth";
import { authRoutes } from "@aotter/mantle/auth/routes";
import { withAuthTasks } from "@aotter/mantle/auth/hardening";
import { isAdmin,  checkOrigin, ContractError, surfaceFailure, type Caller } from "@aotter/mantle/contracts";
import { admin, adminShell } from "@aotter/mantle-admin/server";
import { entries } from "@aotter/mantle-admin/server/entries";
import { siteRoutes } from "@aotter/mantle-admin/server/site";
import { webmcpRoutes } from "@aotter/mantle-admin/server/webmcp";
import { adminMcpApps } from "@aotter/mantle-admin/mcp";
import { mcp as serveMcp, type Tool } from "@aotter/mantle/mcp";
import type { Handle } from "@aotter/mantle/driver/d1";
import { adminBindings } from "../generated/admin-bindings.js";
import { rest } from "../generated/rest.js";
import { tools } from "../generated/mcp.js";
import { mcpAppCatalogues } from "../generated/admin-descriptors.js";
import { handlers, recordOrders } from "./handlers.js";
import { salesPage, searchPage, pageOptions } from "./pages.js";
import type { Handlers } from "../generated/generated.js";

let auth: ReturnType<typeof authLoader<ReturnType<typeof import("./auth.js").createAuth>>> | undefined;
const salesDescriptor = { name: "sales-by-item", title: null, description: null, input: null, list: { columns: [], searchFields: [], filterFields: [], cells: {} }, columns: { name: { schema: "items", field: "name" } } };
const salesBrowserTool = { name: "sales_by_item", description: "Sales grouped by item.", inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: true } };
const addSalesTool = (catalogue: { readonly tools: readonly { readonly name: string }[]; readonly routes: Readonly<Record<string, unknown>> }) => ({ tools: [...catalogue.tools, salesBrowserTool], routes: { ...catalogue.routes, sales_by_item: { path: "/admin/views/sales-by-item" } } });
const extraTools: readonly Tool<Handle, Handlers>[] = [
  { name: "search_items", surface: "public", description: "Search items in native relevance order.", inputSchema: { type: "object", properties: { q: { type: "string", minLength: 1 } }, required: ["q"], additionalProperties: false }, annotations: { readOnlyHint: true }, path: "views/search-items", validate: raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => k !== "q") || typeof (raw as { q?: unknown }).q !== "string") throw new ContractError("INPUT_VALIDATION_FAILED", "Expected q.");
    return raw as Record<string, unknown>;
  }, page: searchPage },
  { name: "sales_by_item", surface: "admin", description: "Sales grouped by item.", inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: true }, closed: true, path: "views/sales-by-item", validate: raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new ContractError("INPUT_VALIDATION_FAILED", "Expected empty input.");
    return {};
  }, page: salesPage },
];
const authorities = new WeakMap<Request, () => Promise<Caller>>();
const options = { db: (env: Env) => env.DB, caller: (request: Request) => authorities.get(request)!(), handlers };
let serveAdmin: ReturnType<typeof admin<Env, Handle, Handlers>> | undefined;
let serveMcpHandler: ReturnType<typeof serveMcp<Env, Handle, Handlers>> | undefined;
const serveRest = rest(options);
export async function fetchService(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  auth ??= authLoader(() => import("./auth.js").then(m => m.createAuth(env)));
  const headers = new Headers();
  let authority: Promise<Caller> | undefined;
  const caller = () => authority ??= resolveCaller(request, auth!, { audience: `${env.PUBLIC_ORIGIN}/mcp`, responseHeaders: headers }).then(value => { checkOrigin(request, value); return value; });
  authorities.set(request, caller);
  const respond = (response: Response) => {
    for (const cookie of headers.getSetCookie()) response.headers.append("set-cookie", cookie);
    return response;
  };
  try {
    const ownAuth = await withAuthTasks(context.waitUntil.bind(context), () => authRoutes(auth!, { methods: [{ kind: "email-otp" }], resolver: caller })(request));
    if (ownAuth) return respond(ownAuth);
    const url = new URL(request.url), paging = { ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}), ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) };
    if (url.pathname === "/api/views/search-items" && request.method === "GET") return respond(Response.json(await searchPage(env.DB, await caller(), { q: url.searchParams.get("q")! }, paging), { headers: { "cache-control": "private, no-store" } }));
    let response: Response | undefined;
    if (url.pathname === "/admin/api" || url.pathname.startsWith("/admin/api/")) {
      if (!serveAdmin) {
        const bindings = adminBindings({handlers});
        const metadata = {...bindings.metadata, views:[...bindings.metadata.views,salesDescriptor],webmcp:addSalesTool(bindings.metadata.webmcp)};
        const salesView = {name:"sales-by-item",allows:(caller:Caller)=>isAdmin(caller),query:(params:URLSearchParams)=>({input:{},...pageOptions({limit:params.has("limit")?Number(params.get("limit")):undefined,cursor:params.get("cursor")??undefined}),cursor:params.get("cursor")??undefined}),page:salesPage};
        const adminOptions = {...options,identity:{directory:async ({caller,request,db}: {caller:Caller;request:Request;db:Handle})=>{const {d1Identity}=await import("@aotter/mantle/auth/identity");return d1Identity(db,await auth!.get(),caller,request.headers);}},mcpEndpoints:{public:"/mcp",admin:"/mcp/admin"}};
        serveAdmin = admin(metadata,[...bindings.views,salesView],bindings.operations,{...adminOptions,developerViews:bindings.developerViews,routes:[...entries(bindings.schemas,bindings.adapter),...siteRoutes(adminOptions),...webmcpRoutes(metadata.webmcp,[...tools,...extraTools],handlers)]});
      }
      response = await serveAdmin(request, env);
    } else if (/^\/mcp(?:\/admin)?\/*$/.test(url.pathname)) {
      if (!serveMcpHandler) {
        serveMcpHandler = serveMcp([...tools, ...extraTools], { ...options, apps: { admin: adminMcpApps({catalogue:{ ...mcpAppCatalogues.admin, views: { ...mcpAppCatalogues.admin.views, sales_by_item: { columns: { name: { type: "string" } }, list: { columns: [] }, actions: [] } } },html:async()=> (await import("@aotter/mantle-admin/mcp-app")).mantleAppHtml}) } });
      }
      response = await serveMcpHandler(request, env);
    } else {
      response = await serveRest(request, env);
    }
    if (response) {
      // Preserve the same post-commit effect for native Admin entry writers.
      if (response.ok && ["POST", "PATCH"].includes(request.method) && /^\/admin\/api\/entries(?:\/[^/]+)?$/.test(decodeURIComponent(url.pathname).replace(/\/$/, "")) && url.searchParams.get("collection")?.toLowerCase() === "orders") {
        const output = await response.clone().json() as { entry: { id: string; data: Record<string, unknown> } };
        await recordOrders(env.DB, await caller(), [{ id: output.entry.id, ...output.entry.data }], request.method === "POST" ? "after_create" : "after_update");
      }
      return respond(response);
    }
    const shell = await adminShell(request, path => env.ASSETS.fetch(new Request(new URL("/admin/" + path, url), request)));
    if (shell) return shell;
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  } catch (error) { return surfaceFailure(error); }
}
