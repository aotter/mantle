/** Dependency-free visitor HTML, Markdown and llms.txt for recipes. */
export const LOCALES = ["zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh-TW";

export interface Recipe {
  slug: string; locale: Locale; title: string; summary: string; ingredients: string; steps: string;
  total_minutes: number; servings: number; cover_url?: string | null; published_at?: string | null; updated_at?: string | null;
}
export interface Listed { slug: string; title: string; summary: string }

// AGENT: move UI strings to your translation workflow when you add locales.
const text = {
  "zh-TW": { site: "食譜", description: "家常食譜，中英對照。", how: "需要多久？", answer: (m: number, s: number) => `總共約 ${m} 分鐘，可供 ${s} 人份。`, ingredients: "材料", steps: "步驟", all: "所有食譜", name: "繁體中文" },
  en: { site: "Recipes", description: "Home recipes in Traditional Chinese and English.", how: "How long does it take?", answer: (m: number, s: number) => `About ${m} minutes in total; serves ${s}.`, ingredients: "Ingredients", steps: "Steps", all: "All recipes", name: "English" },
} satisfies Record<Locale, unknown>;

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
const recipePath = (locale: Locale, slug: string) => `/${locale}/recipes/${slug}`;

/** hreflang alternates for every locale the page exists in, plus x-default (the default locale). */
function alternates(origin: string, locales: readonly Locale[], path: (locale: Locale) => string) {
  return locales.map(l => `<link rel="alternate" hreflang="${l}" href="${origin}${path(l)}">`).join("")
    + `<link rel="alternate" hreflang="x-default" href="${origin}${path(DEFAULT_LOCALE)}">`;
}

/** Open Graph: og:locale uses underscores (zh_TW); the other locales the page exists in are alternates. */
function openGraph(type: "website" | "article", url: string, locale: Locale, locales: readonly Locale[], title: string, description: string) {
  const og = (property: string, content: string) => `<meta property="og:${property}" content="${escape(content)}">`;
  return og("type", type) + og("url", url) + og("site_name", text[locale].site) + og("title", title) + og("description", description)
    + og("locale", locale.replace("-", "_")) + locales.filter(l => l !== locale).map(l => og("locale:alternate", l.replace("-", "_"))).join("");
}

function documentHtml(locale: Locale, head: string, body: string) {
  // AGENT: real layout and styling (stylesheet, header, footer, images sizes); keep the head tags.
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`;
}

function switcher(locales: readonly Locale[], path: (locale: Locale) => string, current: Locale) {
  return `<nav aria-label="Language">${locales.map(l => l === current ? `<strong>${text[l].name}</strong>` : `<a href="${path(l)}" hreflang="${l}" lang="${l}">${text[l].name}</a>`).join(" | ")}</nav>`;
}

export function listHtml(origin: string, locale: Locale, rows: readonly Listed[]) {
  const t = text[locale], path = (l: Locale) => `/${l}/`;
  const head = `<title>${escape(t.site)}</title><meta name="description" content="${escape(t.description)}">`
    + `<link rel="canonical" href="${origin}${path(locale)}">${alternates(origin, LOCALES, path)}`
    + openGraph("website", `${origin}${path(locale)}`, locale, LOCALES, t.site, t.description);
  const items = rows.map(r => `<li><a href="${recipePath(locale, r.slug)}">${escape(r.title)}</a><p>${escape(r.summary)}</p></li>`).join("");
  return documentHtml(locale, head, `${switcher(LOCALES, path, locale)}<h1>${escape(t.site)}</h1><ul>${items}</ul>`);
}

export function recipeHtml(origin: string, locale: Locale, r: Recipe, locales: readonly Locale[]) {
  const t = text[locale], path = (l: Locale) => recipePath(l, r.slug), canonical = `${origin}${path(locale)}`;
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Recipe", name: r.title, description: r.summary, inLanguage: locale, url: canonical,
    ...(r.cover_url ? { image: [r.cover_url] } : {}), ...(r.published_at ? { datePublished: r.published_at } : {}), ...(r.updated_at ? { dateModified: r.updated_at } : {}),
    totalTime: `PT${r.total_minutes}M`, recipeYield: String(r.servings),
    recipeIngredient: lines(r.ingredients),
    recipeInstructions: lines(r.steps).map(step => ({ "@type": "HowToStep", text: step })),
  };
  const head = `<title>${escape(r.title)} | ${escape(t.site)}</title><meta name="description" content="${escape(r.summary)}">`
    + `<link rel="canonical" href="${canonical}">${alternates(origin, locales, path)}`
    + `<link rel="alternate" type="text/markdown" href="${canonical}.md">`
    + openGraph("article", canonical, locale, locales, r.title, r.summary)
    + (r.cover_url ? `<meta property="og:image" content="${escape(r.cover_url)}">` : "")
    // `<` is escaped so admin-authored text cannot close the script element.
    + `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;
  const body = `${switcher(locales, path, locale)}<p><a href="/${locale}/">${escape(t.all)}</a></p>`
    + `<article><h1>${escape(r.title)}</h1><p>${escape(r.summary)}</p>`
    + (r.cover_url ? `<img src="${escape(r.cover_url)}" alt="${escape(r.title)}">` : "")
    // Short answer block: one question and a one-sentence answer that search and answer engines can quote.
    + `<section id="quick-answer"><h2>${escape(t.how)}</h2><p>${escape(t.answer(r.total_minutes, r.servings))}</p></section>`
    + `<h2>${escape(t.ingredients)}</h2><ul>${lines(r.ingredients).map(i => `<li>${escape(i)}</li>`).join("")}</ul>`
    + `<h2>${escape(t.steps)}</h2><ol>${lines(r.steps).map(s => `<li>${escape(s)}</li>`).join("")}</ol></article>`;
  return documentHtml(locale, head, body);
}

export function recipeMarkdown(r: Recipe) {
  const t = text[r.locale];
  return [`# ${r.title}`, "", r.summary, "", `## ${t.how}`, "", t.answer(r.total_minutes, r.servings), "",
    `## ${t.ingredients}`, "", ...lines(r.ingredients).map(i => `- ${i}`), "",
    `## ${t.steps}`, "", ...lines(r.steps).map((s, i) => `${i + 1}. ${s}`), ""].join("\n");
}

/** llms.txt (https://llmstxt.org): one section per locale, each recipe linking to its Markdown alternate. */
export function llmsTxt(origin: string, lists: readonly (readonly [Locale, readonly Listed[]])[]) {
  return [`# ${text.en.site}`, "", `> ${text.en.description}`, "",
    ...lists.flatMap(([locale, rows]) => [`## ${text[locale].name} (${locale})`, "",
      ...rows.map(r => `- [${r.title}](${origin}${recipePath(locale, r.slug)}.md): ${r.summary.replace(/\s+/g, " ")}`), ""])].join("\n");
}
