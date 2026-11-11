/** Route matching for a generated REST table, loaded on the first request; the request pipeline decides the rest. */
import { ContractError } from "./contracts.js";
import { decode, invalid } from "./surface.js";
import { draining } from "./drain.js";
import { canonicalPath } from "./route-pattern.js";
import { isView, openPipeline, type Call } from "./request-pipeline.js";
import type { Fetch, NativeOptions, Route, Send } from "./rest.js";

const SAFE_METHODS = ["GET", "HEAD"];
const fail: (message: string) => never = message => invalid(message, "rest");
const anonymous = () => ({ kind: "anonymous" }) as const;

/** Shared matching/auth/error envelope; selected dispatch is supplied by the surface. */
export function router<Env, Database, Handlers>(
  routes: readonly Route<Database, Handlers, Env>[],
  options: NativeOptions<Env, Database, Handlers>,
  send: Send<Env, Database, Handlers>,
): Fetch<Env> {
  const base = options.base ?? "/api";
  const mounted = (path: string): boolean => path === base || path.startsWith(base + "/");
  return draining(async (request, env, ctx) => {
    const pathname = new URL(request.url).pathname;
    // A mount with an explicit base serves only the paths under it, as written.
    if (options.base !== undefined && !mounted(pathname)) return undefined;
    const pipeline = await openPipeline(ctx, options);
    try {
      await pipeline.select(`rest:${request.method} ${pathname}`);
      await pipeline.resolveForwarded();
      const path = canonicalPath(pathname);
      if (path === undefined || (options.base !== undefined && /%2f|%5c|%00|\\/i.test(pathname))) {
        if (!mounted(pathname)) return undefined;
        fail("Malformed request path.");
      }
      const allowed = new Set<string>();
      for (const route of routes) {
        const match = route.pattern.exec(path);
        if (!match) continue;
        allowed.add(route.method);
        const view = isView(route);
        // HEAD answers a View's GET route without its body.
        const servesHead = request.method === "HEAD" && route.method === "GET" && view;
        if (route.method !== request.method && !servesHead) continue;
        const params = decode(route.keys ?? [], match, "Malformed path parameter.", "rest");
        const call: Call = {
          id: route.id ?? `rest:${route.method} ${decodeURIComponent(path).replace(/\/$/, "")}`,
          view: view && SAFE_METHODS.includes(request.method),
          readOnly: route.readOnly,
          variant: route.variant,
          // A computed target is the dispatch's to authorize, once the request is decoded.
          target: typeof route.target === "function" ? undefined : route.target,
          check: route.check,
          // A native route (`handle`) decides its own credentials.
          scoped: route.handle ? undefined : !!route.scopes?.length,
        };
        const caller = await pipeline.resolveCaller(request, env, options.caller ?? anonymous, call.view);
        if (options.admission) {
          await pipeline.select(call.id);
          const refusal = await options.admission(caller);
          if (refusal) {
            await pipeline.finishResponse(refusal);
            return refusal;
          }
        }
        await pipeline.admit(call);
        pipeline.enforceOrigin(request, call);
        await pipeline.guard(call);
        const response = await send(route, request, env, caller, params, pipeline);
        await pipeline.finishResponse(response);
        return response;
      }
      if (allowed.size) {
        const error = new ContractError("METHOD_NOT_ALLOWED", "Method is not allowed for this route.", "rest");
        const response = await pipeline.failure(error, "rest");
        response.headers.set("allow", [...allowed].join(", "));
        return response;
      }
      if (mounted(path)) throw new ContractError("NOT_FOUND", "No such route.", "rest");
      return undefined;
    } catch (error) {
      return pipeline.failure(error, `rest ${request.method} ${pathname}`);
    }
  });
}
