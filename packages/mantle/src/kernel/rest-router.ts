/** Route matching and caller enforcement load on the first request. */
import { ContractError, checkOrigin, surfaceCaller, surfaceFailure, type Caller, type RequestContext } from "./contracts.js";
import { decode, invalid } from "./surface.js";
import type { Options, Route } from "./rest.js";
const isApi = (path: string): boolean => path === "/api" || path.startsWith("/api/");
const fail: (message: string) => never = message => invalid(message, "rest");
/** Shared matching/auth/error envelope; selected dispatch is supplied by the surface. */
export function router<Env, Database, Handlers>(routes: readonly Route<Database, Handlers, Env>[], options: Options<Env, Database>, send: (route: Route<Database, Handlers, Env>, request: Request, env: Env, caller: Caller, params: Record<string, string>) => Promise<Response>): (request: Request, env: Env, ctx?: RequestContext) => Promise<Response | undefined> {
  return async (request, env, ctx) => {
    let caller: Caller | undefined;
    const forwarded = options.gateway || ctx?.props !== undefined;
    try {
      if (forwarded) caller = (await import("./host-caller.js")).gatewayCaller(ctx, options.gateway, options.fields);
      const original = new URL(request.url).pathname;
      let path: string;
      try { path = original.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/"); } catch { if (!isApi(original)) return undefined; fail("Malformed request path."); }
      const allowed = new Set<string>();
      for (const route of routes) {
        const match = route.pattern.exec(path); if (!match) continue; allowed.add(route.method);
        const read = !!route.page && !route.run && !route.handle;
        if (route.method !== request.method && !(request.method === "HEAD" && route.method === "GET" && read)) continue;
        const params = decode(route.keys ?? [], match, "Malformed path parameter.", "rest");
        caller ??= await surfaceCaller(request, env, options.caller ?? (() => ({ kind: "anonymous" })), read && ["GET", "HEAD"].includes(request.method));
        if (options.gateway) (await import("./host-caller.js")).checkFresh(caller, read || route.readOnly === true, route.target ? route.target.kind + "s/" + route.target.name : path);
        if (!options.gateway || !read && !route.readOnly) checkOrigin(request, caller);
        return await send(route, request, env, caller, params);
      }
      if (allowed.size) { const error = new ContractError("METHOD_NOT_ALLOWED", "Method is not allowed for this route.", "rest"); const response = forwarded ? (await import("./host-caller.js")).hostFailure(error, caller, "rest") : surfaceFailure(error); response.headers.set("allow", [...allowed].join(", ")); return response; }
      if (isApi(path!)) throw new ContractError("NOT_FOUND", "No such route.", "rest");
      return undefined;
    } catch (error) { return forwarded || caller && "authenticatedAs" in caller ? (await import("./host-caller.js")).hostFailure(error, caller, "rest") : surfaceFailure(error, undefined, `rest ${request.method} ${new URL(request.url).pathname}`); }
  };
}

