/** Web output for a generated public View table: /llms.txt, /sitemap.xml, Markdown pages and head tags. SQL owns visibility. */
import { wire, type Caller } from "./contracts.js";
import { convert, decode, type Conversions } from "./surface.js";

/** An app's public Views: row type and input keys per View, and the Views a list may name (no required input). */
export interface App { Rows: Record<string, any>; Inputs: Record<string, string>; List: string }
type At<T, K> = K extends keyof T ? T[K] : never;
type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Params<Rest> : never;
/** A page: the View that reads one row, an optional list View enumerating its URLs, and an optional Markdown text field. */
export type Page<A extends App> = { [V in keyof A["Rows"] & string]: { view: V; list?: A["List"]; markdown?: { [K in keyof A["Rows"][V]]: A["Rows"][V][K] extends string | null ? K : never }[keyof A["Rows"][V]] & string } }[keyof A["Rows"] & string];
type ListKeys<A extends App, T> = T extends { list: infer L extends string } ? keyof At<A["Rows"], L> : string;
/** `{name}` parameters must equal the View input, and be columns of the list and of the View. */
export type Pages<A extends App, P extends Record<string, Page<A>>> = { [K in keyof P]: K extends string ? [Params<K>] extends [At<A["Inputs"], P[K]["view"]>] ? [At<A["Inputs"], P[K]["view"]>] extends [Params<K>] ? [Params<K>] extends [ListKeys<A, P[K]>] ? [Params<K>] extends [keyof At<A["Rows"], P[K]["view"]>] ? P[K] : never : never : never : never : never };
export type Options<A extends App, Database, P extends Record<string, Page<A>>, E> = { db: Database; caller: Caller | ((request: Request, env: E, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>); origin: string; title: string; description: string; locales?: readonly string[]; pages: P & Pages<A, P>; cacheControl?: string };
/** One public View: its query-string reader, paged boundary, bind conversions and boolean input keys. */
export interface View<Database> {
  readonly query: (params: URLSearchParams) => { input: Record<string, unknown> };
  readonly page: (db: Database, caller: Caller, input: never, paging: { limit: number; cursor?: string }) => Promise<{ rows: Record<string, unknown>[]; nextCursor?: string }>;
  readonly convert?: Conversions;
  readonly booleans?: readonly string[];
}

const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const label = (v: unknown) => String(v).replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, "\\$&");
const size = (s: string) => new TextEncoder().encode(s).length;
const NO_STORE = { "cache-control": "no-store" };
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });

export function web<Database, E>(options: { db: Database; caller: Caller | ((request: Request, env: E, authority: { readonly readOnly: boolean }) => Caller | Promise<Caller>); origin: string; title: string; description: string; locales?: readonly string[]; pages: Record<string, { view: string; list?: string; markdown?: string }>; cacheControl?: string }, table: readonly (readonly [string, View<Database>])[]) {
  const views = new Map(table);
  const query = (name: string, db: Database, caller: Caller, params: URLSearchParams, cursor?: string) => {
    const view = views.get(name)!, input = { ...view.query(params).input };
    convert(input, view.convert);
    return view.page(db, caller, input as never, { limit: 500, cursor });
  };
  const origin = new URL(options.origin);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("origin must be an HTTP(S) origin.");
  const pages = Object.entries(options.pages).map(([path, page]) => {
    if (!path.startsWith("/") || /[?#]/.test(path)) throw new TypeError("Page templates must be absolute paths without queries or fragments.");
    const keys: string[] = [];
    const pattern = path.split(/(\{[^{}]+\})/).map(part => part.startsWith("{") ? (keys.push(part.slice(1, -1)), "([^/]+)") : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("");
    return { path, page, keys, pattern: new RegExp("^" + pattern + "$") };
  }).sort((a, b) => a.keys.length - b.keys.length);
  const context = async (request: Request, env: E) => ({ db: options.db, caller: typeof options.caller === "function" ? await options.caller(request, env, { readOnly: ["GET", "HEAD"].includes(request.method) }) : options.caller });
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
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const etag = '"' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") + '"';
    const headers = { "content-type": type + "; charset=utf-8", "cache-control": caller.kind === "anonymous" ? (options.cacheControl ?? "public, max-age=60") : "private, no-store", etag };
    const cached = request.headers.get("if-none-match")?.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
    return new Response(cached || request.method === "HEAD" ? null : body, { status: cached ? 304 : 200, headers });
  };
  return {
    async fetch(request: Request, env?: E): Promise<Response | undefined> {
      if (request.method !== "GET" && request.method !== "HEAD") return;
      const path = new URL(request.url).pathname, index = path === "/llms.txt" || path === "/sitemap.xml";
      try {
        const entry = !index && path.endsWith(".md") ? match(path.slice(0, -3)) : undefined, markdown = entry?.page.markdown;
        if (!index && !markdown) return;
        const ctx = await context(request, env as E);
        if (index) {
          const sitemap = path === "/sitemap.xml", cap = sitemap ? 50000 : 5000, limit = sitemap ? 50 * 1024 * 1024 : 1024 * 1024;
          const start = sitemap ? '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' : "# " + label(options.title) + "\n\n> " + label(options.description) + "\n\n## Pages\n\n", end = sitemap ? "</urlset>" : "\n";
          const links: string[] = []; let visited = 0, requests = 0, bytes = size(start + end); if (bytes > limit) throw new TypeError("Web index header exceeds its byte limit.");
          pagesLoop: for (const entry of pages) {
            if (!entry.page.list) continue;
            let cursor: string | undefined;
            do {
              if (requests >= (sitemap ? 100 : 10)) break pagesLoop; requests++;
              const page = await query(entry.page.list, ctx.db, ctx.caller, new URLSearchParams(), cursor);
              for (const row of page.rows) { if (visited++ >= cap) break pagesLoop; const url = validUrl(entry.path, row, entry.page.view); if (!url) continue; const line = sitemap ? "<url><loc>" + escape(url) + "</loc></url>" : "- [" + label(row.title ?? url) + "](" + url + "): " + label(row.description ?? "") + "\n"; const length = size(line); if (bytes + length > limit) break pagesLoop; bytes += length; links.push(line); }
              if (visited >= cap) break pagesLoop;
              cursor = page.nextCursor;
            } while (cursor);
          }
          return response(request, start + links.join("") + end, sitemap ? "application/xml" : "text/plain", ctx.caller);
        }
        const exact = match(path); if (exact) try { if (await read(exact, ctx)) return; } catch (error) { if (wire(error).status !== 400) throw error; }
        const row = await read(entry!, ctx); if (!row) return notFound();
        const body = row[markdown!]; if (body == null) return notFound(); if (typeof body !== "string") throw new TypeError("Markdown field must return text.");
        return response(request, body, "text/markdown", ctx.caller);
      } catch (error) { const { status, error: body } = wire(error); return Response.json({ error: body }, { status, headers: NO_STORE }); }
    },
    async head(request: Request, env?: E): Promise<string> {
      try {
        const path = new URL(request.url).pathname, entry = match(path); if (!entry) return "";
        const ctx = await context(request, env as E), row = await read(entry, ctx); if (!row) return "";
        const canonical = validUrl(entry.path, row, entry.page.view); if (!canonical) return "";
        let tags = '<link rel="canonical" href="' + escape(canonical) + '">';
        if (entry.page.markdown) tags += '<link rel="alternate" type="text/markdown" href="' + escape(canonical + ".md") + '">';
        if (options.locales?.[0]) tags += '<link rel="alternate" hreflang="' + escape(options.locales[0]) + '" href="' + escape(canonical) + '">';
        for (const key of Object.keys(row)) if (key.endsWith("_lat") && typeof row[key] === "number" && typeof row[key.slice(0, -4) + "_lng"] === "number") { tags += '<meta name="geo.position" content="' + escape(row[key]) + ";" + escape(row[key.slice(0, -4) + "_lng"]) + '">'; break; }
        return tags;
      } catch { return ""; }
    },
  };
}
