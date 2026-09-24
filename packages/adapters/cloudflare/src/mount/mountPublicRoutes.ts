import type { Context, Hono } from "hono";
import type { Entry, SiteConfig } from "@aotter/mantle-spec";
import {
  inferLocaleFromPath,
  toUrlLocale,
} from "@aotter/mantle-runtime";
import {
  absoluteUrl,
  composePageSeoMeta,
  serializeEntryAsMarkdown,
  type MantleWeb,
  type ComposeSitemapRequest,
  type SeoMeta,
} from "@aotter/mantle-web";
import type {
  CloudflareMantleRuntime,
  MantleRuntimeRef,
} from "./bootRuntimeOnce.js";
import { STAFF_ROLE_SET } from "@aotter/mantle-auth";
import { PUBLIC_CACHE_TAG } from "../oauth/cachePolicy.js";

/**
 * `mountPublicRoutes` — mounts the SDK-managed public surface on the
 * consumer's Hono app. Replaces ~140 lines of route-stitching every
 * starter would otherwise hand-roll.
 *
 * Routes (per `collectionRoutes` config):
 *
 *   - `GET /`                                  → 302 to `/{canonicalLocale}` (skipped if `homeRenderer` not set)
 *   - `GET /{locale}`                          → `homeRenderer` (composed; cross-collection)
 *   - `GET /{locale}/{segment}`                → collection list
 *   - `GET /{locale}/{segment}/{slug}`         → entry HTML
 *   - `GET /{locale}/{segment}/{slug}.md`      → entry markdown mirror (AEO)
 *   - `GET /{locale}/{segment}/{slug}?preview=1` → live render via `previewEntry` use case
 *   - `GET /{locale}/llms.txt`                 → composed llms.txt
 *   - `GET /llms.txt`                          → composed root llms.txt
 *   - `GET /robots.txt`                        → crawl policy + sitemap pointer
 *   - `GET /sitemap.xml`                       → composed sitemap
 *
 * Slug overrides intercept `(collection, slug)` pairs the consumer
 * wants to serve from a hand-rolled template (e.g. a contact form
 * page that needs `<TURNSTILE_SITE_KEY>` injected) rather than a
 * rendered entry. Overrides take precedence over preview and the
 * standard renderer.
 *
 * Public responses are rendered from canonical D1 state and carry
 * `s-maxage` for Cloudflare's version-local Workers Cache. TTL collections
 * and `liveDev` use `private, no-store`.
 */
export interface CollectionRouteConfig {
  /** Schema name (e.g. `"post-translations"`). */
  readonly collection: string;
  /** URL segment beneath `/{locale}/`. Empty string puts entries
   *  directly under `/{locale}/{slug}` (rare; useful when a single
   *  collection owns the whole locale tree). */
  readonly segment: string;
  /** When true, expose `GET /{locale}/{segment}` for the collection
   *  list. Default false (most starters use a hand-rolled list page). */
  readonly listRoute?: boolean;
  /** When true, expose `GET /{locale}/{segment}/{slug}.md` for the
   *  AEO markdown mirror. Default true. */
  readonly markdownMirror?: boolean;
  /** Slug to collapse to `/{locale}` (no trailing segment + slug).
   *  Used for the home page when it lives in a translations
   *  collection. */
  readonly homeSlug?: string;
}

export interface PublicContentContext {
  readonly runtime: CloudflareMantleRuntime;
  readonly site: SiteConfig;
  readonly locale: string;
}

export interface PublicRouteContext extends PublicContentContext {
  readonly c: Context;
  readonly seo: SeoMeta;
}

export interface SlugOverride {
  readonly collection: string;
  readonly slug: string;
  readonly render: (ctx: PublicRouteContext) => Promise<Response>;
}

export interface MountPublicRoutesOptions {
  readonly collectionRoutes: ReadonlyArray<CollectionRouteConfig>;
  /** Renderer for `/{locale}` — typically composes home page +
   *  recent posts across collections. Optional; without it `/` and
   *  `/{locale}` are not registered. */
  readonly homeRenderer?: (ctx: PublicRouteContext) => Promise<Response>;
  /** Agent-readable home body for composed homes without one backing Entry. */
  readonly homeMarkdown?: (ctx: PublicContentContext) => Promise<string | null>;
  /** Renderer for the locale 404 fallback. Required — every miss
   *  falls through here. */
  readonly notFoundRenderer: (ctx: PublicRouteContext) => Promise<Response>;
  /** Per-(collection, slug) override taking precedence over standard rendering. */
  readonly slugOverrides?: ReadonlyArray<SlugOverride>;
  /** Live-dev flag — disables public caching for entry / list HTML. */
  readonly liveDev?: boolean;
}

const PUBLIC_CACHE_CONTROL = "public, max-age=0, s-maxage=300";
const PRIVATE_CACHE_CONTROL = "private, no-store";
const HTML_NO_STORE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": PRIVATE_CACHE_CONTROL,
} as const;

const HTML_PUBLIC = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
  "cache-tag": PUBLIC_CACHE_TAG,
} as const;

const MD_PUBLIC = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
  "cache-tag": PUBLIC_CACHE_TAG,
} as const;
const MD_NO_STORE = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": PRIVATE_CACHE_CONTROL,
} as const;

const TEXT_PUBLIC = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
  "cache-tag": PUBLIC_CACHE_TAG,
} as const;

const TEXT_NO_STORE = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": PRIVATE_CACHE_CONTROL,
} as const;

const SITEMAP_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
  "cache-tag": PUBLIC_CACHE_TAG,
} as const;

export function mountPublicRoutes(
  app: Hono,
  ref: MantleRuntimeRef,
  options: MountPublicRoutesOptions,
): void {
  const liveDev = options.liveDev === true;
  const overrideIndex = buildOverrideIndex(options.slugOverrides ?? []);

  // Literal root paths register BEFORE any param-catch-all routes —
  // Hono's trie matches `/llms.txt` against `/:locale` with
  // `:locale = "llms.txt"` if the literal route registers later.
  app.get("/llms.txt", async (c) => {
    const runtime = await ref.get();
    const web = ref.web(runtime);
    const page = await composeLlmsPage(runtime, web, await runtime.siteConfig.load(), options, undefined, c.req.query("cursor"));
    return pagedTextResponse(c, page, hasTtlRoutes(runtime, options.collectionRoutes) ? TEXT_NO_STORE : TEXT_PUBLIC);
  });

  app.get("/robots.txt", async () => {
    const site = await (await ref.get()).siteConfig.load();
    const body = `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(site.origin, "/sitemap.xml")}\n`;
    return new Response(body, { status: 200, headers: TEXT_PUBLIC });
  });

  app.get("/sitemap.xml", async (c) => {
    const runtime = await ref.get();
    const web = ref.web(runtime);
    const site = await runtime.siteConfig.load();
    if (!web.paths) {
      return new Response("sitemap unavailable: no publicPathResolver configured", {
        status: 500,
      });
    }
    const request: ComposeSitemapRequest = {
      site,
      collections: [...new Set(options.collectionRoutes.map(({ collection }) => collection))],
      cursor: c.req.query("cursor"),
      dataFields: web.paths.dataFields,
      maxUrls: Math.max(1, Math.min(2000, Math.floor(40_000 / Math.max(1, site.locales.length)))),
      pathFor: (entry) => {
        const resolved = web.paths!.forEntry(entry);
        if (entry.locale || !resolved) return resolved;
        const route = options.collectionRoutes.find((candidate) => candidate.collection === entry.collection);
        if (!route) return resolved;
        const slug = typeof entry.data["slug"] === "string" ? entry.data["slug"] : entry.id;
        const suffix = route.homeSlug === slug
          ? ""
          : route.segment ? `${route.segment}/${slug}` : slug;
        return site.locales.map((locale) => localizedPath(locale, suffix));
      },
      additionalPaths: options.homeRenderer
        ? site.locales.flatMap((locale) => [
            localizedPath(locale),
            ...options.collectionRoutes
              .filter((route) => route.listRoute && route.segment)
              .map((route) => localizedPath(locale, route.segment)),
          ])
        : [],
    };
    const page = await web.composeSitemap.execute(request);
    const xml = c.req.query("part") === "1" || !page.nextCursor ? page.body
      : await web.composeSitemap.index(request, (cursor) => {
          const query = new URLSearchParams({ part: "1" });
          if (cursor) query.set("cursor", cursor);
          return `/sitemap.xml?${query}`;
        });
    return applyPublicHeaders(new Response(xml, { status: 200, headers: SITEMAP_HEADERS }),
      hasTtlRoutes(runtime, options.collectionRoutes));
  });

  if (options.homeRenderer) {
    app.get("/", async (c) => {
      const runtime = await ref.get();
      const site = await runtime.siteConfig.load();
      const canonical = site.canonicalLocale ?? site.locales[0] ?? "en";
      return c.redirect(`/${toUrlLocale(canonical)}`);
    });
    app.get("/:locale{[^/]+\\.md}", async (c) => {
      const runtime = await ref.get();
      const site = await runtime.siteConfig.load();
      const raw = c.req.param("locale");
      const locale = canonicalLocaleParam(raw.endsWith(".md") ? raw.slice(0, -3) : raw, site.locales);
      if (locale === null) return textNotFound();
      const ctx = buildCtx(c, runtime, site, locale, homeSeo(site, locale, false));
      const body = options.homeMarkdown
        ? await options.homeMarkdown(ctx)
        : await readHomeMarkdown(runtime, options.collectionRoutes, locale);
      return body ? new Response(body, { status: 200,
        headers: hasTtlRoutes(runtime, options.collectionRoutes) ? MD_NO_STORE : MD_PUBLIC }) : textNotFound();
    });
    app.get("/:locale", async (c) => {
      const runtime = await ref.get();
      const site = await runtime.siteConfig.load();
      const locale = canonicalLocaleParam(c.req.param("locale"), site.locales);
      const fallbackLocale = locale ?? inferLocaleFromPath(c.req.path, site);
      if (locale === null) {
        return options.notFoundRenderer(buildCtx(c, runtime, site, fallbackLocale, homeSeo(site, fallbackLocale, false)));
      }
      const baseCtx = buildCtx(c, runtime, site, locale, homeSeo(site, locale, false));
      const markdown = options.homeMarkdown
        ? await options.homeMarkdown(baseCtx)
        : await readHomeMarkdown(runtime, options.collectionRoutes, locale);
      const response = await options.homeRenderer!(
        buildCtx(c, runtime, site, locale, homeSeo(site, locale, markdown !== null)),
      );
      return applyPublicHeaders(response, liveDev || hasTtlRoutes(runtime, options.collectionRoutes));
    });
  }

  app.get("/:locale/llms.txt", async (c) => {
    const runtime = await ref.get();
    const web = ref.web(runtime);
    const locale = canonicalLocaleParam(
      c.req.param("locale"),
      await runtime.siteConfig.readLocales(),
    );
    if (locale === null) return textNotFound();
    const site = await runtime.siteConfig.load();
    const page = await composeLlmsPage(runtime, web, site, options, locale, c.req.query("cursor"));
    return pagedTextResponse(c, page, hasTtlRoutes(runtime, options.collectionRoutes) ? TEXT_NO_STORE : TEXT_PUBLIC);
  });

  for (const route of options.collectionRoutes) {
    mountCollection(app, ref, options, route, liveDev, overrideIndex);
  }

  app.notFound(async (c) => {
    const runtime = await ref.get();
    const site = await runtime.siteConfig.load();
    const locale = inferLocaleFromPath(c.req.path, site);
    return options.notFoundRenderer(buildCtx(c, runtime, site, locale, homeSeo(site, locale, false)));
  });
}

function mountCollection(
  app: Hono,
  ref: MantleRuntimeRef,
  options: MountPublicRoutesOptions,
  route: CollectionRouteConfig,
  liveDev: boolean,
  overrides: ReadonlyMap<string, SlugOverride>,
): void {
  const segPath = route.segment ? `/${route.segment}` : "";

  if (route.listRoute) {
    if (route.markdownMirror !== false && route.segment) {
      app.get(`/:locale${segPath}.md`, async (c) => {
        const runtime = await ref.get();
        const web = ref.web(runtime);
        const locale = canonicalLocaleParam(
          c.req.param("locale") ?? "",
          await runtime.siteConfig.readLocales(),
        );
        if (locale === null) return textNotFound();
        const site = await runtime.siteConfig.load();
        const page = await web.composeLlmsTxt.execute({
          site,
          locale: contentLocale(runtime, route.collection, locale),
          collections: [route.collection],
          cursor: c.req.query("cursor"),
          pathFor: (entry) => entryPathForLocale(web, options.collectionRoutes, entry, locale),
        });
        return pagedTextResponse(c, page, hasTtlCollection(runtime, route.collection) ? MD_NO_STORE : MD_PUBLIC);
      });
    }
    app.get(`/:locale${segPath}`, async (c) => {
      const runtime = await ref.get();
      const web = ref.web(runtime);
      const site = await runtime.siteConfig.load();
      const locale = canonicalLocaleParam(c.req.param("locale"), site.locales);
      const notFound = (): Promise<Response> => {
        const fallbackLocale = locale ?? inferLocaleFromPath(c.req.path, site);
        return options.notFoundRenderer(
          buildCtx(c, runtime, site, fallbackLocale, homeSeo(site, fallbackLocale, false)),
        );
      };
      if (locale === null) return notFound();
      const publicPath = localizedPath(locale, route.segment);
      const schemaTitle = runtime.schemas.get(route.collection)?.spec.title;
      const seo = composePageSeoMeta({
        site,
        locale,
        publicPath,
        title: schemaTitle ? `${schemaTitle} · ${site.brand}` : site.title,
        markdown: route.markdownMirror !== false,
        pathForLocale: (candidate) => localizedPath(candidate, route.segment),
      });
      const page = await web.renderListLive.execute({
        collection: route.collection,
        cursor: c.req.query("cursor"),
        pathForPage: (cursor) => continuationPath(c, cursor)!,
        locale,
        contentLocale: contentLocale(runtime, route.collection, locale),
        site,
        seo,
      });
      if (page === null) return notFound();
      const headers = new Headers(liveDev || hasTtlCollection(runtime, route.collection) ? HTML_NO_STORE : HTML_PUBLIC);
      const next = continuationPath(c, page.nextCursor);
      if (next) headers.set("link", `<${next}>; rel="next"`);
      return new Response(page.html, { status: 200, headers });
    });
  }

  // Register the `.md` mirror BEFORE the bare `:slug` entry route —
  // Hono matches in registration order, so without this the entry
  // route swallows `slug = "foo.md"` and looks up the wrong slug.
  if (route.markdownMirror !== false) {
    // `[^/]+\\.md` (not `.+\\.md`) so a malicious crawler can't
    // squat sub-paths like `/en/posts/long/random.md`; the `:slug`
    // group stays single-segment.
    app.get(`/:locale${segPath}/:slug{[^/]+\\.md}`, async (c) => {
      const runtime = await ref.get();
      const locale = canonicalLocaleParam(
        c.req.param("locale"),
        await runtime.siteConfig.readLocales(),
      );
      const slugParam = c.req.param("slug") ?? "";
      const slug = slugParam.endsWith(".md") ? slugParam.slice(0, -3) : slugParam;
      const notFound = (): Response => textNotFound();
      if (locale === null) return notFound();
      const entry = await runtime.entries.readBySlug({
        collection: route.collection,
        slug,
        locale: contentLocale(runtime, route.collection, locale),
        status: "published",
      });
      if (!entry) return notFound();
      const markdown = serializeEntryAsMarkdown(entry);
      if (!markdown) return notFound();
      return new Response(markdown, {
        status: 200,
        headers: hasTtlCollection(runtime, route.collection) ? MD_NO_STORE : MD_PUBLIC,
      });
    });
  }

  app.get(`/:locale${segPath}/:slug`, async (c) => {
    const runtime = await ref.get();
    const web = ref.web(runtime);
    const locale = canonicalLocaleParam(
      c.req.param("locale"),
      await runtime.siteConfig.readLocales(),
    );
    const slug = c.req.param("slug");
    const loadSite = lazySite(runtime);
    const notFound = async (): Promise<Response> => {
      const site = await loadSite();
      return options.notFoundRenderer(
        buildCtx(
          c,
          runtime,
          site,
          locale ?? inferLocaleFromPath(c.req.path, site),
          homeSeo(site, locale ?? inferLocaleFromPath(c.req.path, site), false),
        ),
      );
    };
    if (locale === null) return notFound();

    const override = overrides.get(overrideKey(route.collection, slug));
    if (override) {
      const site = await loadSite();
      return applyPublicHeaders(
        await override.render(buildCtx(c, runtime, site, locale, homeSeo(site, locale, false))),
        liveDev || hasTtlCollection(runtime, route.collection),
      );
    }

    if (c.req.query("preview") === "1") {
      const denied = await assertStaffSession(ref, c.req.raw);
      if (denied) return denied;
      const site = await loadSite();
      const seoRoute = entrySeoRoute(
        site,
        route,
        locale,
        slug,
        contentLocale(runtime, route.collection, locale) === null,
      );
      const html = await web.previewEntry.execute({
        collection: route.collection,
        slug,
        locale,
        contentLocale: contentLocale(runtime, route.collection, locale),
        site,
        ...seoRoute,
      });
      if (html === null) return notFound();
      return new Response(html, { status: 200, headers: HTML_NO_STORE });
    }

    const site = await loadSite();
    const html = await web.renderEntryLive.execute({
      collection: route.collection,
      slug,
      locale,
      contentLocale: contentLocale(runtime, route.collection, locale),
      site,
      ...entrySeoRoute(
        site,
        route,
        locale,
        slug,
        contentLocale(runtime, route.collection, locale) === null,
      ),
    });
    if (html === null) return notFound();
    return new Response(html, {
      status: 200,
      headers: liveDev || hasTtlCollection(runtime, route.collection) ? HTML_NO_STORE : HTML_PUBLIC,
    });
  });

  if (route.homeSlug && options.homeRenderer == null) {
    // Without a homeRenderer the `homeSlug` collapse is a noop —
    // there's no `/{locale}` route to serve. Surface as a console
    // warning at boot rather than silently misconfiguring.
    console.warn(
      `[mantle] collectionRoute "${route.collection}" declares homeSlug="${route.homeSlug}" ` +
        `but no homeRenderer was passed to mountPublicRoutes — /{locale} will 404.`,
    );
  }
}

/**
 * Gate `?preview=1` behind a staff session so anonymous visitors can't
 * enumerate draft slugs. Returns the denial `Response` on failure (401
 * for no session, 403 for non-staff), or `null` when the caller may
 * proceed.
 */
async function assertStaffSession(
  ref: MantleRuntimeRef,
  req: Request,
): Promise<Response | null> {
  const session = await ref.auth.getSession(req);
  if (!session) return new Response("unauthorized", { status: 401 });
  const role = session.user.roleCurrent
    ? session.user.role ?? null
    : await ref.auth.getUserRole(session.user.id);
  if (!role || !STAFF_ROLE_SET.has(role)) {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

/** Root and locale discovery share one canonical entry page per request. */
async function composeLlmsPage(
  runtime: CloudflareMantleRuntime,
  web: MantleWeb,
  site: SiteConfig,
  options: MountPublicRoutesOptions,
  locale?: string,
  cursor?: string,
): Promise<{ body: string | null; nextCursor?: string }> {
  const locales = locale ? [locale] : site.locales;
  const parts: string[] = [];
  if (!cursor && options.homeMarkdown) {
    for (const candidate of locales) {
      if (await options.homeMarkdown({ runtime, site, locale: candidate })) {
        parts.push(`# ${site.title}\n\nLocale: ${candidate}\n\n## Pages\n\n- [${site.title}](${absoluteUrl(site.origin, `${localizedPath(candidate)}.md`)})\n`);
      }
    }
  }
  const page = await web.composeLlmsTxt.execute({
    site,
    collections: [...new Set(options.collectionRoutes.map(({ collection }) => collection))],
    locale: locale ?? (locales.length ? undefined : null),
    locales: locale || !locales.length ? undefined : locales,
    includeUnlocalized: true,
    cursor,
    pathFor: (entry, candidate) => {
      const route = options.collectionRoutes.find((value) => value.collection === entry.collection);
      const slug = typeof entry.data["slug"] === "string" ? entry.data["slug"] : entry.id;
      if (options.homeMarkdown && route?.homeSlug === slug) return null;
      return entryPathForLocale(web, options.collectionRoutes, entry, candidate);
    },
  });
  if (page?.body) parts.push(page.body);
  return { body: parts.length ? parts.join("\n---\n\n") : null, nextCursor: page?.nextCursor };
}

function continuationPath(c: Context, cursor?: string): string | null {
  if (!cursor) return null;
  const url = new URL(c.req.url);
  url.searchParams.set("cursor", cursor);
  return url.pathname + url.search;
}

function pagedTextResponse(
  c: Context,
  page: { body: string | null; nextCursor?: string } | null,
  initialHeaders: HeadersInit,
): Response {
  const next = continuationPath(c, page?.nextCursor);
  if (!page || (!page.body && !next && !c.req.query("cursor"))) return textNotFound();
  const headers = new Headers(initialHeaders);
  if (next) headers.set("link", `<${next}>; rel="next"`);
  return new Response((page.body ?? (next ? "" : "# No further public documents\n")) + (next ? `\n## Continue\n\n- [Next page](${next})\n` : ""), { headers });
}

function lazySite(runtime: CloudflareMantleRuntime): () => Promise<SiteConfig> {
  let pending: Promise<SiteConfig> | undefined;
  return () => pending ??= runtime.siteConfig.load();
}

function buildCtx(
  c: Context,
  runtime: CloudflareMantleRuntime,
  site: SiteConfig,
  locale: string,
  seo: SeoMeta,
): PublicRouteContext {
  return { c, runtime, site, locale, seo };
}

function homeSeo(site: SiteConfig, locale: string, markdown: boolean): SeoMeta {
  return composePageSeoMeta({
    site,
    locale,
    publicPath: localizedPath(locale),
    markdown,
    pathForLocale: (candidate) => localizedPath(candidate),
  });
}

function localizedPath(locale: string, segment?: string): string {
  return `/${toUrlLocale(locale)}${segment ? `/${segment}` : ""}`;
}

function entrySeoRoute(
  site: SiteConfig,
  route: CollectionRouteConfig,
  locale: string,
  slug: string,
  sharedAcrossLocales: boolean,
): {
  readonly publicPath: string;
  readonly publicLocale: string;
  readonly siblings?: ReadonlyArray<{ readonly locale: string; readonly publicPath: string }>;
} {
  const suffix = route.segment ? `${route.segment}/${slug}` : slug;
  return {
    publicPath: localizedPath(locale, suffix),
    publicLocale: locale,
    ...(!sharedAcrossLocales || !site.locales.some((candidate) => candidate.toLowerCase() !== locale.toLowerCase())
      ? {}
      : {
          siblings: site.locales
            .filter((candidate) => candidate.toLowerCase() !== locale.toLowerCase())
            .map((candidate) => ({ locale: candidate, publicPath: localizedPath(candidate, suffix) })),
        }),
  };
}

function contentLocale(runtime: CloudflareMantleRuntime, collection: string, locale: string): string | null {
  return runtime.schemas.get(collection)?.spec.localized ? locale : null;
}

function hasTtlCollection(runtime: CloudflareMantleRuntime, collection: string): boolean {
  return !!runtime.schemas.get(collection)?.spec.ttl;
}

function hasTtlRoutes(runtime: CloudflareMantleRuntime, routes: ReadonlyArray<CollectionRouteConfig>): boolean {
  return routes.some((route) => hasTtlCollection(runtime, route.collection));
}

function entryPathForLocale(
  web: MantleWeb,
  routes: ReadonlyArray<CollectionRouteConfig>,
  entry: Entry,
  locale: string,
): string | null {
  if (entry.locale) return web.paths?.forEntry(entry) ?? null;
  const route = routes.find((candidate) => candidate.collection === entry.collection);
  if (!route) return web.paths?.forEntry(entry) ?? null;
  const slug = typeof entry.data["slug"] === "string" ? entry.data["slug"] : entry.id;
  return localizedPath(locale, route.homeSlug === slug
    ? ""
    : route.segment ? `${route.segment}/${slug}` : slug);
}

async function readHomeMarkdown(
  runtime: CloudflareMantleRuntime,
  routes: ReadonlyArray<CollectionRouteConfig>,
  locale: string,
): Promise<string | null> {
  const route = routes.find((candidate) => candidate.homeSlug && candidate.markdownMirror !== false);
  if (!route?.homeSlug) return null;
  const entry = await runtime.entries.readBySlug({
    collection: route.collection,
    slug: route.homeSlug,
    locale: contentLocale(runtime, route.collection, locale),
    status: "published",
  });
  return entry ? serializeEntryAsMarkdown(entry) : null;
}

function applyPublicHeaders(response: Response, noStore: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", noStore ? PRIVATE_CACHE_CONTROL : PUBLIC_CACHE_CONTROL);
  if (noStore) headers.delete("cache-tag");
  else headers.set("cache-tag", PUBLIC_CACHE_TAG);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function textNotFound(): Response {
  return new Response("not found", { status: 404, headers: TEXT_NO_STORE });
}

function canonicalLocaleParam(
  locale: string,
  locales: readonly string[],
): string | null {
  const target = locale.toLowerCase();
  return locales.find((candidate) => toUrlLocale(candidate) === target) ?? null;
}

function buildOverrideIndex(
  overrides: ReadonlyArray<SlugOverride>,
): ReadonlyMap<string, SlugOverride> {
  const map = new Map<string, SlugOverride>();
  for (const o of overrides) map.set(overrideKey(o.collection, o.slug), o);
  return map;
}

function overrideKey(collection: string, slug: string): string {
  return `${collection}\u0000${slug}`;
}
