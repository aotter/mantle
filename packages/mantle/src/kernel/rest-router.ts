/** Route matching and caller enforcement load on the first request. */
import { forwarded, ContractError, type Caller, type RequestContext } from "./contracts.js";
import { checkOrigin, surfaceCaller } from "./surface-failure.js";
import { decode, invalid } from "./surface.js";
import { draining } from "./drain.js";
import { canonicalPath } from "./route-pattern.js";
import type { Options, Route } from "./rest.js";
const isApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");
const fail: (message: string) => never = message => invalid(message, "rest");
/** Shared matching/auth/error envelope; selected dispatch is supplied by the surface. */
export function router<Env, Database, Handlers>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database>, send: (route: Route<Database, Handlers, Env>, request: Request, env: Env, caller: Caller, params: Record<string, string>, access?: ReturnType<typeof import("./host-access.js").accessRequest>) => Promise<Response>): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  return draining(async (request, env, ctx) => {
    let caller: Caller | undefined;
    const isForwarded = forwarded(ctx, options.gateway);
    const access = options.gateway ? (await import("./host-access.js")).accessRequest(ctx, options) : undefined;
    try {
      await access?.select(`rest:${request.method} ${new URL(request.url).pathname}`);
      if (isForwarded) caller = (await import("./host-caller.js")).gatewayCaller(ctx, options.gateway, options.fields);
      const original = new URL(request.url).pathname;
      const path = canonicalPath(original);
      if (path === undefined) { if (!isApi(original)) return undefined; fail("Malformed request path."); }
      const allowed = new Set<string>();
      for (const route of routes) {
        const match = route.pattern.exec(path); if (!match) continue; allowed.add(route.method);
        const read = !!route.page && !route.run && !route.handle;
        if (route.method !== request.method && !(request.method === "HEAD" && route.method === "GET" && read)) continue;
        const params = decode(route.keys ?? [], match, "Malformed path parameter.", "rest");
        const id = route.id ?? `rest:${route.method} ${decodeURIComponent(path).replace(/\/$/, "")}`;
        await access?.select(id);
        caller ??= await surfaceCaller(request, env, options.caller ?? (() => ({ kind: "anonymous" })), read && ["GET", "HEAD"].includes(request.method));
        await access?.select(id, caller);
        await access?.check(read || route.readOnly === true);
        if (!options.gateway || !read && !route.readOnly) checkOrigin(request, caller);
        const response = await send(route, request, env, caller, params, access);
        await access?.finishResponse(response);
        return response;
      }
      if (allowed.size) { const error = new ContractError("METHOD_NOT_ALLOWED", "Method is not allowed for this route.", "rest"); access?.finish(error); const response = (await import("./host-caller.js")).hostFailure(error, caller, "rest"); response.headers.set("allow", [...allowed].join(", ")); return response; }
      if (isApi(path)) throw new ContractError("NOT_FOUND", "No such route.", "rest");
      return undefined;
    } catch (error) { access?.finish(error); return (await import("./host-caller.js")).hostFailure(error, caller, `rest ${request.method} ${new URL(request.url).pathname}`); }
  });
}

