import type { Caller } from "@aotter/mantle/contracts";
import { store } from "../generated/generated.js";
import { translationLocales } from "../generated/translations.js";
import recipePage from "../generated/paged/views/published_recipes.js";
import translationPage from "../generated/paged/views/published_translations.js";
import { DEFAULT_LOCALE, LOCALES, type Locale, type Recipe, listHtml, llmsTxt, recipeHtml, recipeMarkdown } from "./pages.js";

// Visitor pages always read as anonymous, even for a signed-in admin, so drafts never reach public HTML.
const visitor: Caller = { kind: "anonymous" };
const page = /^\/(zh-TW|en)\/(?:recipes\/([a-z0-9-]+?)(\.md)?)?$/;

/**
 * Visitor pages, tried before Admin, MCP and REST. Only these paths are matched; everything else falls through.
 *   /                          -> redirect to /zh-TW/
 *   /{locale}/                 list (HTML)
 *   /{locale}/recipes/{slug}   detail (HTML: SEO meta, hreflang, JSON-LD Recipe, short answer)
 *   /{locale}/recipes/{slug}.md  Markdown alternate
 *   /llms.txt                  published recipes for AI agents
 */
export async function appRoutes(request: Request, env: Env, _context: { caller: () => Promise<Caller>; waitUntil: (task: Promise<unknown>) => void }): Promise<Response | undefined> {
  const url = new URL(request.url), match = page.exec(url.pathname);
  if (url.pathname !== "/" && url.pathname !== "/llms.txt" && !match) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  // Absolute links use the configured origin, not the request Host.
  const origin = env.PUBLIC_ORIGIN;
  if (url.pathname === "/") return Response.redirect(`${origin}/${DEFAULT_LOCALE}/`, 302);

  if (url.pathname === "/llms.txt") {
    const lists = await Promise.all(LOCALES.map(async locale => [locale, await list(env, locale)] as const));
    return send(request, llmsTxt(origin, lists), "text/plain; charset=utf-8");
  }

  const locale = match![1] as Locale, slug = match![2], markdown = !!match![3];
  if (!slug) return send(request, listHtml(origin, locale, await list(env, locale)), "text/html; charset=utf-8");
  const found = await read(env, slug, locale);
  if (!found) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return markdown
    ? send(request, recipeMarkdown(found.recipe), "text/markdown; charset=utf-8", { link: `<${origin}/${locale}/recipes/${slug}>; rel="canonical"` })
    : send(request, recipeHtml(origin, locale, found.recipe, found.locales), "text/html; charset=utf-8");
}

/** First page of published recipes in one locale. AGENT: page with `nextCursor` once a locale has more than 100 recipes. */
async function list(env: Env, locale: Locale) {
  const result = locale === DEFAULT_LOCALE
    ? await recipePage(env.DB, visitor, {}, { limit: 100 })
    : await translationPage(env.DB, visitor, { locale }, { limit: 100 });
  return result.rows.map(row => ({ slug: String(row.slug), title: String(row.title), summary: String(row.summary) }));
}

/** One published recipe in `locale` plus the locales it is published in (for hreflang). */
async function read(env: Env, slug: string, locale: Locale): Promise<{ recipe: Recipe; locales: Locale[] } | undefined> {
  const recipes = store(env.DB, visitor);
  const parent = await recipes.collection("recipes").first({ where: { slug } });
  if (!parent) return undefined;
  const translated = (await translationLocales(env.DB, visitor, "recipes", [parent]))[parent.id] ?? [];
  const locales = LOCALES.filter(l => l === DEFAULT_LOCALE || translated.includes(l));
  if (!locales.includes(locale)) return undefined;
  // A translation read merges the parent's fields (total_minutes, servings, cover_url, ...); the child's own fields win.
  const row = locale === DEFAULT_LOCALE ? parent : await recipes.collection("recipe_translations").first({ where: { slug, locale } });
  if (!row) return undefined;
  return { recipe: { ...row, slug, locale } as Recipe, locales };
}

function send(request: Request, body: string, type: string, headers: Record<string, string> = {}) {
  // AGENT: choose a cache policy (and purge on publish) once pages sit behind a CDN.
  return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": type, "cache-control": "no-store", ...headers } });
}
