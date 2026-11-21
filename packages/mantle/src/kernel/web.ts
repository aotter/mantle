/** Web output for a generated public View table: /llms.txt, /sitemap.xml, Markdown pages and head tags. SQL owns visibility. */
import type { Authorize, Caller, Gateway, GatewayOptions, RequestContext } from "./contracts.js";
import type { CallerResolver } from "./request-pipeline.js";
import type { UserFields } from "./user-fields.js";
import type { Conversions } from "./surface.js";

/** An app's public Views: row type and input keys per View, and the Views a list may name (input that accepts no fields). */
export interface App {
  Rows: Record<string, any>;
  Inputs: Record<string, string>;
  List: string;
}
type At<T, K> = K extends keyof T ? T[K] : never;
type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Params<Rest> : never;
/** The columns of View `V` that hold text, which a page may render as Markdown. */
type TextColumns<A extends App, V extends keyof A["Rows"]> = {
  [K in keyof A["Rows"][V]]: A["Rows"][V][K] extends string | null ? K : never;
}[keyof A["Rows"][V]] &
  string;
/**
 * A page: the View that reads one row, an optional list View enumerating its URLs, an optional Markdown text field, and
 * an optional text or timestamp column of the list for the sitemap's `<lastmod>`.
 */
export type Page<A extends App> = {
  [V in keyof A["Rows"] & string]: {
    view: V;
    list?: A["List"];
    markdown?: TextColumns<A, V>;
    lastmod?: { [L in A["List"]]: TextColumns<A, L & keyof A["Rows"]> }[A["List"]];
  };
}[keyof A["Rows"] & string];
type ListKeys<A extends App, T> = T extends { list: infer L extends string } ? keyof At<A["Rows"], L> : string;
/** `lastmod` names a text column of the page's own list. */
type Lastmod<A extends App, T> = T extends { lastmod: infer M }
  ? T extends { list: infer L extends keyof A["Rows"] }
    ? M extends TextColumns<A, L>
      ? T
      : never
    : never
  : T;
/** `{name}` parameters must equal the View input, and be columns of the list and of the View; `lastmod` is the list's. */
export type Pages<A extends App, P extends Record<string, Page<A>>> = {
  [K in keyof P]: K extends string
    ? [Params<K>] extends [At<A["Inputs"], P[K]["view"]>]
      ? [At<A["Inputs"], P[K]["view"]>] extends [Params<K>]
        ? [Params<K>] extends [ListKeys<A, P[K]>]
          ? [Params<K>] extends [keyof At<A["Rows"], P[K]["view"]>]
            ? Lastmod<A, P[K]>
            : never
          : never
        : never
      : never
    : never;
};
/** Options of a generated `web(...)`: it supplies the manifest's `fields` itself. */
export type Options<A extends App, Database, P extends Record<string, Page<A>>, E> = Omit<
  WebOptions<Database, E>,
  "pages" | "fields"
> & { pages: P & Pages<A, P> };
/** The row `head()` accepts for the pages `P`: a row of one of their Views. */
export type PageRow<A extends App, P extends Record<string, Page<A>>> = A["Rows"][P[keyof P]["view"]];
/** One page of a View's rows. */
export type ViewPage = { rows: Record<string, unknown>[]; nextCursor?: string };
/** One public View: its query-string reader, paged boundary, bind conversions and boolean input keys. */
export interface View<Database> {
  readonly check?: (caller: Caller) => void;
  /** The scopes the generated `requires` names; only such a View admits a service credential. */
  readonly scopes?: readonly string[];
  /** The input rejects an empty query, so a list cannot name this View. */
  readonly unlisted?: true;
  readonly query: (params: URLSearchParams) => { input: Record<string, unknown> };
  readonly page: (
    db: Database,
    caller: Caller,
    input: never,
    paging: { limit: number; cursor?: string },
  ) => Promise<ViewPage>;
  readonly convert?: Conversions;
  readonly booleans?: readonly string[];
}

export interface WebHandler<E, R = Record<string, unknown>> {
  fetch(request: Request, env?: E, ctx?: RequestContext): Promise<Response | undefined>;
  /** Head tags of the page at `request`; given the `row` the application already read, it reads no View. */
  head(request: Request, env?: E, ctx?: RequestContext, page?: { row: R }): Promise<string>;
}
/** A page as an application declares it. */
export type PageSpec = { view: string; list?: string; markdown?: string; lastmod?: string };
/** A declared page with its compiled URL template. */
export type PageEntry = { path: string; page: PageSpec; keys: string[]; pattern: RegExp };
export type WebOptions<Database, E> = {
  db: Database;
  caller?: Caller | CallerResolver<E>;
  origin: string;
  title: string;
  description: string;
  locales?: readonly string[];
  pages: Record<string, PageSpec>;
  /** Static paths (home, list pages) the sitemap lists before the pages' rows. */
  sitemap?: readonly string[];
  cacheControl?: string;
  /** Host platform contract, versioned by `v`; stable within a version. */
  gateway?: Gateway;
  fields?: UserFields;
  authorize?: Authorize;
} & Pick<GatewayOptions, "onAccess" | "accessTargets">;
export function web<Database, E>(
  options: WebOptions<Database, E>,
  table: readonly (readonly [string, View<Database>])[],
): WebHandler<E> {
  const views = new Map(table);
  for (const [path, page] of Object.entries(options.pages)) {
    if (!page.list || !views.get(page.list)?.unlisted) continue;
    const reason = "whose input rejects an empty query; a list View must accept no input.";
    throw new TypeError(`Page ${path} lists View '${page.list}', ${reason}`);
  }
  const origin = new URL(options.origin);
  const bare = !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash;
  if (!/^https?:$/.test(origin.protocol) || !bare) throw new TypeError("origin must be an HTTP(S) origin.");
  // A sitemap path is a literal URL path, so it holds no `{name}` parameter either.
  const bad = (path: string, banned: RegExp) => !path.startsWith("/") || banned.test(path);
  if (Object.keys(options.pages).some(p => bad(p, /[?#]/)) || options.sitemap?.some(p => bad(p, /[?#{}]/)))
    throw new TypeError("Page templates and sitemap paths must be absolute paths without queries or fragments.");
  const pages: PageEntry[] = Object.entries(options.pages)
    .map(([path, page]) => {
      const keys: string[] = [];
      const pattern = path
        .split(/(\{[^{}]+\})/)
        .map(part =>
          part.startsWith("{") ? (keys.push(part.slice(1, -1)), "([^/]+)") : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return { path, page, keys, pattern: new RegExp("^" + pattern + "$") };
    })
    .sort((a, b) => a.keys.length - b.keys.length);
  if (options.gateway || options.authorize) {
    let selected: WebHandler<E> | undefined;
    const load = async () => (selected ??= (await import("./web-gateway.js")).selectedWeb(options, views, pages));
    return {
      fetch: async (request: Request, env?: E, ctx?: RequestContext) => (await load()).fetch(request, env, ctx),
      head: async (request: Request, env?: E, ctx?: RequestContext, page?: { row: Record<string, unknown> }) =>
        (await load()).head(request, env, ctx, page),
    };
  }
  let served: WebHandler<E> | undefined;
  const serve = async () => (served ??= (await import("./web-serve.js")).serve(options, views, pages));
  return {
    async fetch(request: Request, env?: E, execution?: RequestContext): Promise<Response | undefined> {
      if (request.method !== "GET" && request.method !== "HEAD") return;
      const path = new URL(request.url).pathname;
      if (path !== "/llms.txt" && path !== "/sitemap.xml" && !path.endsWith(".md")) return;
      return (served ?? (await serve())).fetch(request, env, execution);
    },
    head: async (request: Request, env?: E, execution?: RequestContext, page?: { row: Record<string, unknown> }) =>
      (served ?? (await serve())).head(request, env, execution, page),
  };
}
