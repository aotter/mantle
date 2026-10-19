/** Request-time web handling, loaded on the first web request. */
import { forwarded, wire, ContractError, type Caller, type RequestContext } from "./contracts.js";
import { decode } from "./surface.js";
import type { View, WebOptions } from "./web.js";

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
type Entry = { path: string; page: { view: string; list?: string; markdown?: string }; keys: string[]; pattern: RegExp };

export function serve<Database, E>(options: WebOptions<Database, E>, views: Map<string, View<Database>>, pages: Entry[], query: (name: string, db: Database, caller: Caller, params: URLSearchParams, cursor?: string) => ReturnType<View<Database>["page"]>) {
  const origin = new URL(options.origin);
  const context = async (request: Request, env: E, ctx?: RequestContext) => ({ db: options.db, caller: forwarded(ctx, options.gateway)
    ? (await import("./host-caller.js")).gatewayCaller(ctx, options.gateway, options.fields)
    : typeof options.caller === "function" ? await options.caller(request, env, { readOnly: ["GET", "HEAD"].includes(request.method) }) : options.caller ?? { kind: "anonymous" as const } });
  const urlFor = (path: string, row: Record<string, unknown>, view: string) => origin.origin + path.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    let value = row[key]; if (views.get(view)!.booleans?.includes(key) && (value === 0 || value === 1)) value = Boolean(value); if (value === null || value === undefined) throw new TypeError("List View must return every page parameter: " + key);
    const segment = String(value); if (segment === "." || segment === "..") return "";
    return encodeURIComponent(segment).replace(/[()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  });
  const validUrl = (path: string, row: Record<string, unknown>, view: string) => { if ([...path.matchAll(/\{([^{}]+)\}/g)].some(([, key]) => row[key!] === "." || row[key!] === "..")) return; return urlFor(path, row, view); };
  const match = (path: string) => {
    for (const entry of pages) { const hit = entry.pattern.exec(path); if (!hit) continue; return { ...entry, params: new URLSearchParams(decode(entry.keys, hit, "Malformed URL parameter.", "web/path")) }; }
  };
  const read = async (entry: NonNullable<ReturnType<typeof match>>, ctx: Awaited<ReturnType<typeof context>>) => (await query(entry.page.view, ctx.db, ctx.caller, entry.params)).rows[0];
  const response = async (request: Request, body: string, type: string, caller: Caller) => {
    const { webResponse } = await import('./web-response.js');
    return webResponse(request, body, type, caller.kind === "anonymous" ? (options.cacheControl ?? "public, max-age=60") : "private, no-store");
  };
  return {
    async fetch(request: Request, env?: E, execution?: RequestContext): Promise<Response | undefined> {
      let caller: Caller | undefined;
      try {
        if (request.method !== "GET" && request.method !== "HEAD") return;
        const path = new URL(request.url).pathname, index = path === "/llms.txt" || path === "/sitemap.xml";
        const entry = !index && path.endsWith(".md") ? match(path.slice(0, -3)) : undefined, markdown = entry?.page.markdown;
        if (!index && !markdown) return;
        const ctx = await context(request, env as E, execution); caller = ctx.caller;
        if (index) {
          const sitemap = path === "/sitemap.xml";
          const body = await (await import("./web-index.js")).webIndex(sitemap, options, pages, (list, cursor) => query(list, ctx.db, ctx.caller, new URLSearchParams(), cursor), validUrl);
          return response(request, body, sitemap ? "application/xml" : "text/plain", ctx.caller);
        }
        const exact = match(path); if (exact) try { if (await read(exact, ctx)) return; } catch (error) { if (wire(error).status !== 400) throw error; }
        const row = await read(entry!, ctx); if (!row) return notFound();
        const body = row[markdown!]; if (body == null) return notFound(); if (typeof body !== "string") throw new TypeError("Markdown field must return text.");
        return response(request, body, "text/markdown", ctx.caller);
      } catch (error) { return (await import("./host-caller.js")).hostFailure(error, caller, "web"); }
    },
    async head(request: Request, env?: E, execution?: RequestContext): Promise<string> {
      try {
        const path = new URL(request.url).pathname, entry = match(path); if (!entry) return "";
        const ctx = await context(request, env as E, execution), row = await read(entry, ctx); if (!row) return "";
        const canonical = validUrl(entry.path, row, entry.page.view); if (!canonical) return "";
        return (await import("./web-head.js")).headTags(canonical, row, !!entry.page.markdown, options.locales);
      } catch (error) { if (error instanceof ContractError && error.code === "HOST_CONTRACT") throw error; return ""; }
    },
  };
}
