/**
 * The REST surface (ADR-0032 decision 9): a Fetch function over the runtime. Public Views are `GET {basePath}/views/<name>`;
 * each HTTP Trigger is its own method and path (which the grammar requires to start with `/api/`), with path params
 * bound to the Procedure's input.
 */
import type { JsonSchema } from "../spec/domain/index.js";
import type { MantleRuntime, Surface } from "../core/index.js";
import { coerce, failure, json, match, readJsonObject, viewQuery, wireError } from "../core/wire.js";

// Public routing does not imply public data: Views and Triggers can depend on the Caller.
const NO_STORE = { "cache-control": "private, no-store" };

export interface RestSurfaceOptions {
  /** Where the Views are mounted, e.g. `/api`. HTTP Trigger paths are absolute. */
  readonly basePath: string;
}

export function createRestSurface(runtime: MantleRuntime, options: RestSurfaceOptions): Surface {
  const base = options.basePath.replace(/\/+$/, "");
  const { plan } = runtime;
  const params = (path: string) => path.split("/").filter((s) => s.startsWith("{")).length;
  // a route with fewer path params is more specific, so `/items/search` is never shadowed by `/items/{id}`
  const routes = Object.entries(plan.triggers)
    .flatMap(([name, t]) => (t.source.kind === "http" ? [{ name, method: t.source.method, path: t.source.path, procedure: t.procedure }] : []))
    .sort((a, b) => params(a.path) - params(b.path));

  return async (request, caller, executionRuntime = runtime) => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const view = request.method === "GET" ? match(`${base}/views/{name}`, path)?.name : undefined;
      if (view !== undefined) {
        const v = plan.views[view];
        if (!v || v.surface !== "public") throw wireError("NOT_FOUND", `no public View '${view}'`, "rest");
        const rows = await executionRuntime.store.as(caller).view(view, viewQuery(view, v, url.searchParams, "rest"));
        // only an anonymous read of a cacheable View is shared-cacheable; Vary keeps a cache from answering a signed-in request with it
        return json(rows, 200, v.sharedMaxAge !== undefined && caller.kind === "anonymous" ? { "cache-control": `public, s-maxage=${v.sharedMaxAge}`, vary: "authorization, cookie" } : NO_STORE);
      }

      for (const route of routes) {
        if (route.method !== request.method) continue;
        const params = match(route.path, path);
        if (!params) continue;
        const props = plan.procedures[route.procedure]?.input.properties ?? {};
        const body = await readJsonObject(request, "rest");
        const input = { ...body, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, coerce(v, props[k] as JsonSchema | undefined, k, "rest")])) };
        return json(await executionRuntime.invokeProcedure({ procedure: route.procedure, input, caller, cause: { kind: "http", id: crypto.randomUUID() } }), 200, NO_STORE);
      }
      throw wireError("NOT_FOUND", "no such route", "rest");
    } catch (e) {
      return failure(e, "rest", NO_STORE);
    }
  };
}
