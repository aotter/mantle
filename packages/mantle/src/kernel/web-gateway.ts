/** Selected web authorization loads on a request, outside the ordinary web startup graph. */
import { web, type View, type WebOptions, type WebHandler } from "./web.js";
import { gatewayCaller, hostFailure } from "./host-caller.js";
import { accessRequest } from "./host-access.js";
import { authorizeTarget } from "./authorization.js";
import { forwarded, ContractError, type Caller, type RequestContext } from "./contracts.js";

export function gatewayWeb<Database, E>(options: WebOptions<Database, E>, table: readonly (readonly [string, View<Database>])[]): WebHandler<E> {
  const run = async (method: "fetch" | "head", request: Request, env?: E, ctx?: RequestContext): Promise<Response | string | undefined> => {
    let caller: Caller | undefined, failure: unknown, ran = false;
    const access = options.gateway ? accessRequest(ctx, options) : undefined;
    try {
      const pathname = new URL(request.url).pathname, path = method === "fetch" ? pathname.replace(/\.md$/, "") : pathname;
      const page = Object.entries(options.pages).sort(([a], [b]) => (a.match(/\{[^{}]+\}/g)?.length ?? 0) - (b.match(/\{[^{}]+\}/g)?.length ?? 0)).find(([template]) => new RegExp("^" + template.split(/(\{[^{}]+\})/).map(part => part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("") + "$").test(path))?.[1];
      const index = pathname === "/llms.txt" || pathname === "/sitemap.xml";
      if (method === "fetch" ? !["GET", "HEAD"].includes(request.method) || !index && (!pathname.endsWith(".md") || !page?.markdown) : !page) return method === "head" ? "" : undefined;
      const name = page?.view ?? Object.values(options.pages).find(p => p.list)?.list;
      await access?.select(name ? `view:${name}` : "web");
      caller = forwarded(ctx, options.gateway) ? gatewayCaller(ctx, options.gateway, options.fields) : typeof options.caller === "function" ? await options.caller(request, env as E, {readOnly:true}) : options.caller ?? {kind:"anonymous"};
      const site = web<Database, E>({...options, gateway: undefined, authorize: undefined, onAccess: undefined, caller}, table.map(([name, view]) => [name, {...view, page: async (...args) => {
        try {
          ran = true;
          await access?.select(`view:${name}`, caller);
          await access?.check(true);
          view.check?.(caller!);
          if (options.authorize) await authorizeTarget(options.authorize, {kind:"view",name}, caller!);
          if (access?.dryRun) return {rows: []};
          return view.page(...args);
        } catch (error) { failure = error; throw error; }
      }}] as const));
      // The ordinary renderer validates query/path fields; wrapped pages decide before any SQL.
      const result = await site[method](request, env, options.gateway ? undefined : ctx);
      if (failure) throw failure;
      if (result === undefined) return;
      if (access && result instanceof Response && result.status >= 400) {
        const payload = await result.clone().json().catch(() => null) as {error?:{code:string;path?:string;field?:string}} | null;
        if (payload?.error) throw new ContractError(payload.error.code, "", payload.error.path, {status:result.status, fields:payload.error.field ? {field:payload.error.field} : undefined});
      }
      if (!ran) return result;
      if (access?.dryRun) { const response = access.response(); return method === "fetch" ? response : ""; }
      access?.finish();
      return result;
    } catch (error) {
      access?.finish(error);
      if (method === "head") throw error;
      return hostFailure(error, caller, "web");
    }
  };
  return {
    fetch: (request: Request, env?: E, ctx?: RequestContext) => run("fetch", request, env, ctx) as Promise<Response | undefined>,
    head: (request: Request, env?: E, ctx?: RequestContext) => run("head", request, env, ctx) as Promise<string>,
  };
}
