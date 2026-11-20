import type { Caller } from "@aotter/mantle/contracts";
import recipePage from "../generated/paged/views/published_recipes.js";
import translationPage from "../generated/paged/views/published_translations.js";
import { web } from "../generated/web.js";
import { signInPage } from "./sign-in.js";
import { DEFAULT_LOCALE, LOCALES, type Locale, siteDefaults } from "./site-config.js";

// Visitor pages always read as anonymous, even for a signed-in admin: drafts never reach them, and every visitor gets
// the same bytes, so a shared cache may keep them. AGENT: keep both; nothing per-visitor goes into these pages.
const visitor: Caller = { kind: "anonymous" };
// AGENT: every response states its cache policy. Public pages: briefly cached, served stale while revalidating or when
// the origin fails. Redirects, 404s, errors and anything that depends on the caller: no-store.
const PUBLIC = "public, max-age=60, stale-while-revalidate=600, stale-if-error=86400";
const NO_STORE = { "cache-control": "no-store" };
const page = /^\/(zh-TW|en)\/(?:recipes\/([a-z0-9-]+))?$/;

/** `.md` alternates, /llms.txt, /sitemap.xml and the head tags of each recipe page, from the public Views. */
const site = (env: Env) => web({
  db: env.DB, caller: visitor, origin: env.PUBLIC_ORIGIN, title: siteDefaults.title, description: siteDefaults.description,
  locales: LOCALES, sitemap: LOCALES.map(locale => `/${locale}/`), cacheControl: PUBLIC,
  pages: {
    "/zh-TW/recipes/{slug}": { view: "published_recipes", list: "published_recipes", markdown: "markdown", lastmod: "updated_at" },
    "/{locale}/recipes/{slug}": { view: "published_translations", list: "published_translations", markdown: "markdown", lastmod: "updated_at" },
  },
});

/**
 * Visitor pages, tried before Admin, MCP and REST. Only these paths are matched; everything else falls through.
 *   /                            -> redirect to /zh-TW/
 *   /{locale}/                   list (HTML)
 *   /{locale}/recipes/{slug}     detail (HTML: SEO meta, hreflang, JSON-LD Recipe, short answer, save button)
 *   /{locale}/recipes/{slug}.md  Markdown alternate (web())
 *   /llms.txt, /sitemap.xml      every published recipe in every locale (web())
 *   /robots.txt                  keeps crawlers out of /admin/
 *   /sign-in                     member sign-in (the shell's src/sign-in.ts), where the save button sends anonymous visitors
 */
export async function appRoutes(request: Request, env: Env, _context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  const url = new URL(request.url), match = page.exec(url.pathname);
  if (url.pathname === "/sign-in" && request.method === "GET") return signInPage();
  const generated = await site(env).fetch(request, env);
  if (generated) return generated;
  if (!["/", "/robots.txt"].includes(url.pathname) && !match) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD", ...NO_STORE } });
  // Absolute links use the configured origin, not the request Host.
  const origin = env.PUBLIC_ORIGIN;
  if (url.pathname === "/") return new Response(null, { status: 302, headers: { location: `${origin}/${DEFAULT_LOCALE}/`, ...NO_STORE } });
  if (url.pathname === "/robots.txt") return send(request, `User-agent: *\nDisallow: /admin/\nSitemap: ${origin}/sitemap.xml\n`, "text/plain; charset=utf-8");

  const locale = match![1] as Locale, slug = match![2];
  // React loads here, beside the read, on the first page request of an isolate (src/html.tsx).
  if (!slug) {
    const [{ listHtml }, rows] = await Promise.all([import("./html.js"), list(env, locale)]);
    return send(request, listHtml({ origin, locale, rows }), "text/html; charset=utf-8");
  }
  const [{ recipeHtml }, found] = await Promise.all([import("./html.js"), read(env, locale, slug)]);
  if (!found) return new Response("Not found", { status: 404, headers: NO_STORE });
  // The row this page read: web() builds its tags from it without a second query.
  const tags = await site(env).head(request, env, undefined, { row: found.recipe });
  return send(request, recipeHtml({ origin, locale, ...found }, tags), "text/html; charset=utf-8");
}

/** First page of published recipes in one locale. AGENT: page with `nextCursor` once a locale has more than 100 recipes. */
async function list(env: Env, locale: Locale) {
  const result = locale === DEFAULT_LOCALE
    ? await recipePage(env.DB, visitor, { slug: null }, { limit: 100 })
    : await translationPage(env.DB, visitor, { locale, slug: null }, { limit: 100 });
  return result.rows;
}

/** One published recipe in `locale` plus the locales it is published in (for hreflang): two reads at once. */
async function read(env: Env, locale: Locale, slug: string) {
  const [parent, translations] = await Promise.all([
    recipePage(env.DB, visitor, { slug }, { limit: 1 }),
    translationPage(env.DB, visitor, { locale: null, slug }, { limit: 100 }),
  ]);
  const recipe = locale === DEFAULT_LOCALE ? parent.rows[0] : translations.rows.find(row => row.locale === locale);
  if (!recipe) return undefined;
  return { recipe, locales: LOCALES.filter(l => l === DEFAULT_LOCALE || translations.rows.some(row => row.locale === l)) };
}

function send(request: Request, body: string, type: string) {
  return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": type, "cache-control": PUBLIC } });
}
