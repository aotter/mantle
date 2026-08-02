import type { Context, Env as HonoEnv, Hono } from "hono";
import type { SiteConfig } from "@aotter/mantle-spec";
import {
  entryHtmlKeyFromParts,
  entryMarkdownKeyFromParts,
  inferLocaleFromPath,
  listHtmlKey,
  llmsTxtKey,
  serializeEntryAsMarkdown,
  toUrlLocale,
  type CmsRuntime,
  type KvCache,
} from "@aotter/mantle-runtime";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";
import { STAFF_ROLE_SET } from "../auth/createAuth.js";

/**
 * `mountPublicRoutes` — mounts the SDK-managed public surface on the
 * consumer's Hono app. Replaces ~140 lines of route-stitching every
 * starter would otherwise hand-roll.
 *
 * Routes (per `collectionRoutes` config):
 *
 *   - `GET /`                                  → 302 to `/{canonicalLocale}` (skipped if `homeRenderer` not set)
 *   - `GET /{locale}`                          → `homeRenderer` (composed; cross-collection)
 *   - `GET /{locale}/{segment}`                → KV-cached collection list
 *   - `GET /{locale}/{segment}/{slug}`         → KV-cached entry HTML
 *   - `GET /{locale}/{segment}/{slug}.md`      → KV-cached entry markdown mirror (AEO)
 *   - `GET /{locale}/{segment}/{slug}?preview=1` → live render via `previewEntry` use case
 *   - `GET /{locale}/llms.txt`                 → KV-cached llms.txt
 *   - `GET /llms.txt`                          → KV-cached root llms.txt
 *   - `GET /sitemap.xml`                       → composed sitemap
 *
 * Slug overrides intercept `(collection, slug)` pairs the consumer
 * wants to serve from a hand-rolled template (e.g. a contact form
 * page that needs `<TURNSTILE_SITE_KEY>` injected) rather than a
 * pre-rendered KV blob. Overrides take precedence over preview /
 * live-dev / KV.
 *
 * `liveDev: true` (typically `env.MANTLE_LOCAL_DEV === "1"`) bypasses
 * KV for entry / list HTML — every request live-renders against
 * current D1 state via the `RenderEntryLiveUseCase` /
 * `RenderListLiveUseCase`. `.md` mirrors and `llms.txt` still come
 * from KV (those are cheap to rebuild via `pnpm fixture`). Don't set
 * in production — defeats the publish pipeline cache.
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
   *  AEO markdown mirror. Default true — the publish pipeline already
   *  writes the mirror to KV; not exposing it would be silent waste. */
  readonly markdownMirror?: boolean;
  /** Slug to collapse to `/{locale}` (no trailing segment + slug).
   *  Used for the home page when it lives in a translations
   *  collection. */
  readonly homeSlug?: string;
}

export interface PublicRouteContext<E extends HonoEnv = HonoEnv> {
  readonly c: Context<E>;
  readonly runtime: CmsRuntime;
  readonly site: SiteConfig;
  readonly locale: string;
}

export interface SlugOverride<E extends HonoEnv = HonoEnv> {
  readonly collection: string;
  readonly slug: string;
  readonly render: (ctx: PublicRouteContext<E>) => Promise<Response>;
}

export interface MountPublicRoutesOptions<E extends HonoEnv = HonoEnv> {
  readonly collectionRoutes: ReadonlyArray<CollectionRouteConfig>;
  /** Renderer for `/{locale}` — typically composes home page +
   *  recent posts across collections. Optional; without it `/` and
   *  `/{locale}` are not registered. */
  readonly homeRenderer?: (ctx: PublicRouteContext<E>) => Promise<Response>;
  /** Renderer for the locale 404 fallback. Required — every miss
   *  falls through here. */
  readonly notFoundRenderer: (ctx: PublicRouteContext<E>) => Promise<Response>;
  /** Per-(collection, slug) override taking precedence over KV. */
  readonly slugOverrides?: ReadonlyArray<SlugOverride<E>>;
  /** Live-dev flag — bypasses KV for entry / list HTML. Default
   *  false. */
  readonly liveDev?: boolean;
}

const PUBLIC_CACHE_CONTROL = "public, max-age=0, s-maxage=300";
const PRIVATE_CACHE_CONTROL = "private, no-store";
const ROOT_LLMS_FALLBACK_TTL_SECONDS = 300;

const HTML_NO_STORE = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": PRIVATE_CACHE_CONTROL,
} as const;

const HTML_PUBLIC = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
} as const;

const MD_PUBLIC = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
} as const;

const TEXT_PUBLIC = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
} as const;

const TEXT_NO_STORE = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": PRIVATE_CACHE_CONTROL,
} as const;

const SITEMAP_HEADERS = {
  "content-type": "application/xml; charset=utf-8",
  "cache-control": PUBLIC_CACHE_CONTROL,
} as const;

export function mountPublicRoutes<E extends HonoEnv>(
  app: Hono<E>,
  ref: CmsRuntimeRef,
  options: MountPublicRoutesOptions<E>,
): void {
  const liveDev = options.liveDev === true;
  const overrideIndex = buildOverrideIndex(options.slugOverrides ?? []);

  // Literal root paths register BEFORE any param-catch-all routes —
  // Hono's trie matches `/llms.txt` against `/:locale` with
  // `:locale = "llms.txt"` if the literal route registers later.
  //
  // Live-fallback on KV miss: a first-visit AI agent (or a freshly-
  // deployed worker that hasn't published anything yet) gets a
  // composed body inline; the cache write rides ctx.waitUntil so the
  // response stays fast and subsequent requests hit the warm KV.
  app.get("/llms.txt", async (c) => {
    const runtime = await ref.get();
    return readThroughCache(
      runtime.kv,
      llmsTxtKey(""),
      TEXT_PUBLIC,
      async () => composeRootLlmsTxt(runtime, await runtime.siteConfig.load()),
      {
        executionCtx: safeExecutionCtx(c),
        expirationTtl: ROOT_LLMS_FALLBACK_TTL_SECONDS,
      },
    );
  });

  app.get("/sitemap.xml", async (c) => {
    const runtime = await ref.get();
    const site = await runtime.siteConfig.load();
    if (!runtime.publicPathResolver) {
      return new Response("sitemap unavailable: no publicPathResolver configured", {
        status: 500,
      });
    }
    const xml = await runtime.composeSitemap.execute({
      site,
      pathFor: (e) => runtime.publicPathResolver!.forEntry(e),
    });
    return new Response(xml, { status: 200, headers: SITEMAP_HEADERS });
  });

  if (options.homeRenderer) {
    app.get("/", async (c) => {
      const runtime = await ref.get();
      const site = await runtime.siteConfig.load();
      const canonical = site.canonicalLocale ?? site.locales[0] ?? "en";
      return c.redirect(`/${toUrlLocale(canonical)}`);
    });
    app.get("/:locale", async (c) => {
      const runtime = await ref.get();
      const site = await runtime.siteConfig.load();
      const locale = canonicalLocaleParam(c.req.param("locale"), site.locales);
      const ctx = buildCtx(c, runtime, site, locale ?? inferLocaleFromPath(c.req.path, site));
      if (locale === null) return options.notFoundRenderer(ctx);
      return options.homeRenderer!(ctx);
    });
  }

  app.get("/:locale/llms.txt", async (c) => {
    const runtime = await ref.get();
    const locale = canonicalLocaleParam(
      c.req.param("locale"),
      await runtime.siteConfig.readLocales(),
    );
    if (locale === null) return new Response("not found", { status: 404, headers: TEXT_NO_STORE });
    return readThroughCache(
      runtime.kv,
      llmsTxtKey(locale),
      TEXT_PUBLIC,
      async () => runtime.composeLlmsTxt.execute({
        site: await runtime.siteConfig.load(),
        locale,
      }),
      { executionCtx: safeExecutionCtx(c) },
    );
  });

  for (const route of options.collectionRoutes) {
    mountCollection(app, ref, options, route, liveDev, overrideIndex);
  }

  app.notFound(async (c) => {
    const runtime = await ref.get();
    const site = await runtime.siteConfig.load();
    const locale = inferLocaleFromPath(c.req.path, site);
    return options.notFoundRenderer(buildCtx(c, runtime, site, locale));
  });
}

function mountCollection<E extends HonoEnv>(
  app: Hono<E>,
  ref: CmsRuntimeRef,
  options: MountPublicRoutesOptions<E>,
  route: CollectionRouteConfig,
  liveDev: boolean,
  overrides: ReadonlyMap<string, SlugOverride<E>>,
): void {
  const segPath = route.segment ? `/${route.segment}` : "";

  if (route.listRoute) {
    app.get(`/:locale${segPath}`, async (c) => {
      const runtime = await ref.get();
      const locale = canonicalLocaleParam(
        c.req.param("locale"),
        await runtime.siteConfig.readLocales(),
      );
      const loadSite = lazySite(runtime);
      const notFound = async (): Promise<Response> => {
        const site = await loadSite();
        return options.notFoundRenderer(
          buildCtx(c, runtime, site, locale ?? inferLocaleFromPath(c.req.path, site)),
        );
      };
      if (locale === null) return notFound();
      if (liveDev) {
        const site = await loadSite();
        const html = await runtime.renderListLive.execute({
          collection: route.collection,
          locale,
          site,
        });
        if (html === null) return notFound();
        return new Response(html, { status: 200, headers: HTML_NO_STORE });
      }
      return readThroughCache(runtime.kv, listHtmlKey(route.collection, locale), HTML_PUBLIC, async () =>
        runtime.renderListLive.execute({
          collection: route.collection,
          locale,
          site: await loadSite(),
        }), {
          fallback: notFound,
          executionCtx: safeExecutionCtx(c),
        });
    });
  }

  // Register the `.md` mirror BEFORE the bare `:slug` entry route —
  // Hono matches in registration order, so without this the entry
  // route swallows `slug = "foo.md"` and 404s on KV lookup.
  if (route.markdownMirror !== false) {
    // `[^/]+\\.md` (not `.+\\.md`) so a malicious crawler can't
    // squat sub-paths like `/en/posts/long/random.md` and burn KV
    // reads — the `:slug` group stays single-segment.
    app.get(`/:locale${segPath}/:slug{[^/]+\\.md}`, async (c) => {
      const runtime = await ref.get();
      const locale = canonicalLocaleParam(
        c.req.param("locale"),
        await runtime.siteConfig.readLocales(),
      );
      const slugParam = c.req.param("slug") ?? "";
      const slug = slugParam.endsWith(".md") ? slugParam.slice(0, -3) : slugParam;
      const notFound = (): Response => new Response("not found", { status: 404, headers: TEXT_NO_STORE });
      if (locale === null) return notFound();
      const key = entryMarkdownKeyFromParts(route.collection, locale, slug);
      return readThroughCache(runtime.kv, key, MD_PUBLIC, async () => {
        const entry = await runtime.entryReader.readBySlug({
          collection: route.collection,
          slug,
          locale,
          status: "published",
        });
        if (!entry) return null;
        return serializeEntryAsMarkdown(entry);
      }, {
        fallback: notFound,
        executionCtx: safeExecutionCtx(c),
      });
    });
  }

  app.get(`/:locale${segPath}/:slug`, async (c) => {
    const runtime = await ref.get();
    const locale = canonicalLocaleParam(
      c.req.param("locale"),
      await runtime.siteConfig.readLocales(),
    );
    const slug = c.req.param("slug");
    const loadSite = lazySite(runtime);
    const notFound = async (): Promise<Response> => {
      const site = await loadSite();
      return options.notFoundRenderer(
        buildCtx(c, runtime, site, locale ?? inferLocaleFromPath(c.req.path, site)),
      );
    };
    if (locale === null) return notFound();

    const override = overrides.get(overrideKey(route.collection, slug));
    if (override) {
      const site = await loadSite();
      return override.render(buildCtx(c, runtime, site, locale));
    }

    if (c.req.query("preview") === "1") {
      const denied = await assertStaffSession(ref, c.req.raw);
      if (denied) return denied;
      const site = await loadSite();
      const html = await runtime.previewEntry.execute({
        collection: route.collection,
        slug,
        locale,
        site,
      });
      if (html === null) return notFound();
      return new Response(html, { status: 200, headers: HTML_NO_STORE });
    }

    if (liveDev) {
      const site = await loadSite();
      const html = await runtime.renderEntryLive.execute({
        collection: route.collection,
        slug,
        locale,
        site,
      });
      if (html === null) return notFound();
      return new Response(html, { status: 200, headers: HTML_NO_STORE });
    }

    const key = entryHtmlKeyFromParts(route.collection, locale, slug);
    return readThroughCache(runtime.kv, key, HTML_PUBLIC, async () => {
      const html = await runtime.renderEntryLive.execute({
        collection: route.collection,
        slug,
        locale,
        site: await loadSite(),
      });
      return html;
    }, {
      fallback: notFound,
      executionCtx: safeExecutionCtx(c),
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
  ref: CmsRuntimeRef,
  req: Request,
): Promise<Response | null> {
  const session = await ref.auth.getSession(req);
  if (!session) return new Response("unauthorized", { status: 401 });
  const role = await ref.auth.getUserRole(session.user.id);
  if (!role || !STAFF_ROLE_SET.has(role)) {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

/** Hono throws on `c.executionCtx` access when there is no
 *  ExecutionContext (test harnesses, in-process `app.request`).
 *  Wrap the read so callers can opt out of background write-back
 *  silently — the read-through helper falls back to an inline `await`. */
interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

function safeExecutionCtx<E extends HonoEnv>(c: Context<E>): WaitUntilContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Cross-locale aggregate body for `/llms.txt` (no `:locale` segment).
 *
 * `ComposeLlmsTxtUseCase.execute({ locale: null })` returns
 * non-localized entries only — fine for sites with no `locales`
 * declared, but emits an effectively empty document for sites whose
 * content lives entirely in localized child schemas (the typical
 * publication / intake / landing shape).
 *
 * For those sites, concatenate the per-locale composer outputs so an
 * AI agent landing at the bare `/llms.txt` sees every published
 * locale's URL table. The composer always emits a `Locale: <tag>`
 * header in localized mode, so the sections self-separate without a
 * custom delimiter.
 */
async function composeRootLlmsTxt(
  runtime: CmsRuntime,
  site: SiteConfig,
): Promise<string> {
  if (site.locales.length === 0) {
    return runtime.composeLlmsTxt.execute({ site, locale: null });
  }
  const parts: string[] = [];
  for (const locale of site.locales) {
    const body = await runtime.composeLlmsTxt.execute({ site, locale });
    if (body.trim()) parts.push(body);
  }
  return parts.length > 0 ? parts.join("\n---\n\n") : "";
}

async function readThroughCache(
  kv: KvCache,
  key: string,
  headers: Record<string, string>,
  populate: () => Promise<string | null>,
  options: {
    readonly fallback?: () => Promise<Response> | Response;
    readonly executionCtx?: WaitUntilContext;
    readonly expirationTtl?: number;
  } = {},
): Promise<Response> {
  const cached = await kv.get(key);
  if (cached !== null) return new Response(cached, { status: 200, headers });

  const rendered = await populate();
  if (rendered === null) {
    if (options.fallback) return options.fallback();
    return new Response("not found", { status: 404, headers: TEXT_NO_STORE });
  }

  const writeBack = kv.put(
    key,
    rendered,
    options.expirationTtl === undefined
      ? undefined
      : { expirationTtl: options.expirationTtl },
  );
  if (options.executionCtx) options.executionCtx.waitUntil(writeBack);
  else await writeBack;
  return new Response(rendered, { status: 200, headers });
}

function lazySite(runtime: CmsRuntime): () => Promise<SiteConfig> {
  let pending: Promise<SiteConfig> | undefined;
  return () => pending ??= runtime.siteConfig.load();
}

function buildCtx<E extends HonoEnv>(
  c: Context<E>,
  runtime: CmsRuntime,
  site: SiteConfig,
  locale: string,
): PublicRouteContext<E> {
  return { c, runtime, site, locale };
}

function canonicalLocaleParam(
  locale: string,
  locales: readonly string[],
): string | null {
  const target = locale.toLowerCase();
  return locales.find((candidate) => toUrlLocale(candidate) === target) ?? null;
}

function buildOverrideIndex<E extends HonoEnv>(
  overrides: ReadonlyArray<SlugOverride<E>>,
): ReadonlyMap<string, SlugOverride<E>> {
  const map = new Map<string, SlugOverride<E>>();
  for (const o of overrides) map.set(overrideKey(o.collection, o.slug), o);
  return map;
}

function overrideKey(collection: string, slug: string): string {
  return `${collection}\u0000${slug}`;
}
