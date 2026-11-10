/** Request-time web handling, loaded on the first web request: Markdown pages, the two indexes and head tags. */
import { wire, ContractError, type Caller, type RequestContext } from "./contracts.js";
import { openPipeline, type Call, type Pipeline } from "./request-pipeline.js";
import { convert, decode } from "./surface.js";
import type { PageEntry, View, ViewPage, WebHandler, WebOptions } from "./web.js";

const NO_STORE = { "cache-control": "no-store" };
const SAFE_METHODS = ["GET", "HEAD"];
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
const hostFailure = async (error: unknown, caller: Caller | undefined) =>
  (await import("./host-caller.js")).hostFailure(error, caller, "web");
/** The caller option as a resolver: a function, a fixed caller, or nobody. */
export const callerResolver = <E>(caller: WebOptions<unknown, E>["caller"]) =>
  typeof caller === "function" ? caller : () => caller ?? { kind: "anonymous" as const };

/**
 * One request's caller and its View reads. Every read goes through the pipeline; `ran` and `failure` tell a selected
 * surface (gateway mode or application `authorize`) whether a read was decided and how it failed.
 */
export interface Visit {
  readonly caller: Caller;
  /** A View read reached the pipeline's decision. */
  ran: boolean;
  /** What the last refused or failed read threw, even where the renderer answers it with an empty result. */
  failure?: unknown;
  read(view: string, params: URLSearchParams, cursor?: string): Promise<ViewPage>;
}

/** The renderers of a site, each given how to open the request's visit. */
export interface Site<E> extends WebHandler<E> {
  visit(request: Request, pipeline: Pipeline, caller: Caller): Visit;
  render(request: Request, open: () => Promise<Visit>): Promise<Response | undefined>;
  renderHead(request: Request, open: () => Promise<Visit>): Promise<string>;
}

export function serve<Database, E>(
  options: WebOptions<Database, E>,
  views: Map<string, View<Database>>,
  pages: PageEntry[],
): Site<E> {
  const origin = new URL(options.origin);
  const resolver = callerResolver(options.caller);

  /** The visit over an open pipeline: decode the View input, then admit, guard and (unless a dry run) page. */
  const visit = (request: Request, pipeline: Pipeline, caller: Caller): Visit => {
    const state: Visit = {
      caller,
      ran: false,
      async read(name, params, cursor) {
        const view = views.get(name)!,
          input = { ...view.query(params).input };
        convert(input, view.convert);
        const call: Call = { id: `view:${name}`, view: true, target: { kind: "view", name }, check: view.check };
        try {
          state.ran = true;
          await pipeline.admit(call);
          pipeline.enforceOrigin(request, call);
          await pipeline.guard(call);
          if (pipeline.dryRun) return { rows: [] };
          return await view.page(options.db, caller, input as never, { limit: 500, cursor });
        } catch (error) {
          state.failure = error;
          throw error;
        }
      },
    };
    return state;
  };
  /** An ordinary site resolves its own caller, once the request matched something it serves. */
  const open = (request: Request, env: E, ctx?: RequestContext) => async () => {
    const pipeline = await openPipeline(ctx, options);
    return visit(
      request,
      pipeline,
      await pipeline.resolveCaller(request, env, resolver, SAFE_METHODS.includes(request.method)),
    );
  };

  const segmentFor = (row: Record<string, unknown>, view: string) => (_: string, key: string) => {
    let value = row[key];
    if (views.get(view)!.booleans?.includes(key) && (value === 0 || value === 1)) value = Boolean(value);
    if (value === null || value === undefined)
      throw new TypeError("List View must return every page parameter: " + key);
    const segment = String(value);
    if (segment === "." || segment === "..") return "";
    return encodeURIComponent(segment).replace(/[()]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  };
  const urlFor = (path: string, row: Record<string, unknown>, view: string) =>
    origin.origin + path.replace(/\{([^{}]+)\}/g, segmentFor(row, view));
  const validUrl = (path: string, row: Record<string, unknown>, view: string) => {
    if ([...path.matchAll(/\{([^{}]+)\}/g)].some(([, key]) => row[key!] === "." || row[key!] === "..")) return;
    return urlFor(path, row, view);
  };
  const match = (path: string) => {
    for (const entry of pages) {
      const hit = entry.pattern.exec(path);
      if (hit)
        return {
          ...entry,
          params: new URLSearchParams(decode(entry.keys, hit, "Malformed URL parameter.", "web/path")),
        };
    }
  };
  const row = async (entry: NonNullable<ReturnType<typeof match>>, reader: Visit) =>
    (await reader.read(entry.page.view, entry.params)).rows[0];
  const respond = async (request: Request, body: string, type: string, caller: Caller) => {
    const { webResponse } = await import("./web-response.js");
    const cacheControl =
      caller.kind === "anonymous" ? (options.cacheControl ?? "public, max-age=60") : "private, no-store";
    return webResponse(request, body, type, cacheControl);
  };

  const render = async (request: Request, openVisit: () => Promise<Visit>): Promise<Response | undefined> => {
    let caller: Caller | undefined;
    try {
      if (!SAFE_METHODS.includes(request.method)) return;
      const path = new URL(request.url).pathname,
        index = path === "/llms.txt" || path === "/sitemap.xml";
      const entry = !index && path.endsWith(".md") ? match(path.slice(0, -3)) : undefined,
        markdown = entry?.page.markdown;
      if (!index && !markdown) return;
      const reader = await openVisit();
      caller = reader.caller;
      if (index) {
        const sitemap = path === "/sitemap.xml";
        const list = (view: string, cursor?: string) => reader.read(view, new URLSearchParams(), cursor);
        const body = await (await import("./web-index.js")).webIndex(sitemap, options, pages, list, validUrl);
        return respond(request, body, sitemap ? "application/xml" : "text/plain", caller);
      }
      // A page whose own URL ends in `.md` is that page, not the Markdown of another.
      const exact = match(path);
      if (exact)
        try {
          if (await row(exact, reader)) return;
        } catch (error) {
          if (wire(error).status !== 400) throw error;
        }
      const found = await row(entry!, reader);
      if (!found) return notFound();
      const body = found[markdown!];
      if (body == null) return notFound();
      if (typeof body !== "string") throw new TypeError("Markdown field must return text.");
      return respond(request, body, "text/markdown", caller);
    } catch (error) {
      return hostFailure(error, caller);
    }
  };
  const renderHead = async (request: Request, openVisit: () => Promise<Visit>): Promise<string> => {
    try {
      const entry = match(new URL(request.url).pathname);
      if (!entry) return "";
      const found = await row(entry, await openVisit());
      if (!found) return "";
      const canonical = validUrl(entry.path, found, entry.page.view);
      if (!canonical) return "";
      return (await import("./web-head.js")).headTags(canonical, found, !!entry.page.markdown, options.locales);
    } catch (error) {
      if (error instanceof ContractError && error.code === "HOST_CONTRACT") throw error;
      return "";
    }
  };
  return {
    visit,
    render,
    renderHead,
    fetch: (request, env, ctx) => render(request, open(request, env as E, ctx)),
    head: (request, env, ctx) => renderHead(request, open(request, env as E, ctx)),
  };
}
