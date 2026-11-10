/**
 * A selected web surface (gateway mode or application `authorize`) loads on a request, outside the ordinary web
 * startup graph. It resolves the caller before rendering, renders through the ordinary site, and then settles what
 * the site rendered: a refused View read fails the request even where the renderer would answer an empty result.
 */
import { ContractError, type RequestContext } from "./contracts.js";
import { openPipeline } from "./request-pipeline.js";
import { callerResolver, serve } from "./web-serve.js";
import type { PageEntry, View, WebHandler, WebOptions } from "./web.js";

type ErrorBody = { error?: { code: string; path?: string; field?: string } } | null;

export function selectedWeb<Database, E>(
  options: WebOptions<Database, E>,
  views: Map<string, View<Database>>,
  pages: PageEntry[],
): WebHandler<E> {
  const site = serve(options, views, pages);
  const resolver = callerResolver(options.caller);
  /** The View an index request is observed against: the first page that lists one. */
  const listed = Object.values(options.pages).find(page => page.list)?.list;

  const run = async (method: "fetch" | "head", request: Request, env?: E, ctx?: RequestContext) => {
    const pipeline = await openPipeline(ctx, options);
    try {
      const pathname = new URL(request.url).pathname,
        path = method === "fetch" ? pathname.replace(/\.md$/, "") : pathname;
      const page = pages.find(entry => entry.pattern.test(path))?.page;
      const index = pathname === "/llms.txt" || pathname === "/sitemap.xml";
      const served =
        method === "fetch"
          ? ["GET", "HEAD"].includes(request.method) && (index || (pathname.endsWith(".md") && !!page?.markdown))
          : !!page;
      if (!served) return method === "head" ? "" : undefined;
      const name = page?.view ?? listed;
      await pipeline.select(name ? `view:${name}` : "web");
      const caller = await pipeline.resolveCaller(request, env as E, resolver, true);
      const visit = site.visit(request, pipeline, caller);
      // The ordinary renderer validates query/path fields; each View read is decided before any SQL.
      const opened = async () => visit;
      const result = method === "fetch" ? await site.render(request, opened) : await site.renderHead(request, opened);
      if (visit.failure) throw visit.failure;
      if (result === undefined) return;
      // A host observes the renderer's own refusal (a malformed path field, say) by its code.
      if (pipeline.gateway && result instanceof Response && result.status >= 400) {
        const payload = (await result
          .clone()
          .json()
          .catch(() => null)) as ErrorBody;
        const fields = payload?.error?.field ? { field: payload.error.field } : undefined;
        if (payload?.error)
          throw new ContractError(payload.error.code, "", payload.error.path, { status: result.status, fields });
      }
      if (!visit.ran) return result;
      if (pipeline.dryRun) {
        const response = pipeline.dryRunResponse();
        return method === "fetch" ? response : "";
      }
      pipeline.finish();
      return result;
    } catch (error) {
      pipeline.finish(error);
      if (method === "head") throw error;
      return pipeline.failure(error, "web");
    }
  };
  return {
    fetch: (request: Request, env?: E, ctx?: RequestContext) =>
      run("fetch", request, env, ctx) as Promise<Response | undefined>,
    head: (request: Request, env?: E, ctx?: RequestContext) => run("head", request, env, ctx) as Promise<string>,
  };
}
