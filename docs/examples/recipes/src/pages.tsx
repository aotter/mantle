/**
 * The visitor pages as React components, rendered to HTML on the server (src/html.tsx) with the content in the body.
 * Plain elements styled with class names from the one stylesheet (src/client/page.css: the kit's kit.css plus a few
 * layout rules). AGENT: keep kit components (@aotter/mantle-ui/kit) out of these server pages: they only produce class
 * names, and they double a new isolate's first render. The browser island (src/client/save.tsx) may use them.
 */
import type { ReactNode } from "react";
import type { Row } from "../generated/views/published_recipes.js";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./site-config.js";

/** A row of `published_recipes`; a `published_translations` row has the same columns plus `locale`. */
export type Recipe = Row;
type Listed = Pick<Row, "slug" | "title" | "description">;

// AGENT: move UI strings to your translation workflow when you add locales.
const text = {
  "zh-TW": { site: "食譜", description: "家常食譜，中英對照。", how: "需要多久？", answer: (m: number, s: number) => `總共約 ${m} 分鐘，可供 ${s} 人份。`, ingredients: "材料", steps: "步驟", all: "所有食譜", name: "繁體中文", save: "儲存這道食譜", saved: "已儲存" },
  en: { site: "Recipes", description: "Home recipes in Traditional Chinese and English.", how: "How long does it take?", answer: (m: number, s: number) => `About ${m} minutes in total; serves ${s}.`, ingredients: "Ingredients", steps: "Steps", all: "All recipes", name: "English", save: "Save this recipe", saved: "Saved" },
} satisfies Record<Locale, unknown>;

const lines = (value: string | null) => (value ?? "").split("\n").map(line => line.trim()).filter(Boolean);
const recipePath = (locale: Locale, slug: string | null) => `/${locale}/recipes/${slug}`;
const link = "text-primary underline-offset-4 hover:underline";

function Document({ locale, title, head, children }: { locale: Locale; title: string; head: ReactNode; children: ReactNode }) {
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/assets/client/page.css" />
        {head}
      </head>
      <body>
        <main className="page">{children}</main>
        {/* The island loader: a few hundred bytes without React; a module script never blocks rendering. */}
        <script type="module" src="/assets/client/page.js" />
      </body>
    </html>
  );
}

/** hreflang alternates for every locale the page exists in, plus x-default (the default locale). */
function Alternates({ origin, locales, path }: { origin: string; locales: readonly Locale[]; path: (locale: Locale) => string }) {
  return [...locales, "x-default" as const].map(l => <link key={l} rel="alternate" hrefLang={l} href={origin + path(l === "x-default" ? DEFAULT_LOCALE : l)} />);
}

/** Open Graph: og:locale uses underscores (zh_TW); the other locales the page exists in are alternates. */
function OpenGraph(p: { type: "website" | "article"; url: string; locale: Locale; locales: readonly Locale[]; title: string | null; description: string | null; image?: string | null }) {
  const underscore = (l: Locale) => l.replace("-", "_");
  const tags = [["type", p.type], ["url", p.url], ["site_name", text[p.locale].site], ["title", p.title], ["description", p.description],
    ["locale", underscore(p.locale)], ...p.locales.filter(l => l !== p.locale).map(l => ["locale:alternate", underscore(l)]), ["image", p.image]];
  return tags.map(([property, content], i) => (content ? <meta key={i} property={`og:${property}`} content={content} /> : null));
}

function Switcher({ locales, path, current }: { locales: readonly Locale[]; path: (locale: Locale) => string; current: Locale }) {
  return (
    <nav aria-label="Language" className="flex gap-2 text-sm">
      {locales.map(l => (l === current ? <strong key={l}>{text[l].name}</strong> : <a key={l} href={path(l)} hrefLang={l} lang={l} className={link}>{text[l].name}</a>))}
    </nav>
  );
}

export function ListPage({ origin, locale, rows }: { origin: string; locale: Locale; rows: readonly Listed[] }) {
  const t = text[locale], path = (l: Locale) => `/${l}/`, canonical = origin + path(locale);
  const head = (
    <>
      <meta name="description" content={t.description} />
      <link rel="canonical" href={canonical} />
      <Alternates origin={origin} locales={LOCALES} path={path} />
      <OpenGraph type="website" url={canonical} locale={locale} locales={LOCALES} title={t.site} description={t.description} />
    </>
  );
  return (
    <Document locale={locale} title={t.site} head={head}>
      <Switcher locales={LOCALES} path={path} current={locale} />
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">{t.site}</h1>
      <ul className="mt-4 space-y-3">
        {rows.map(r => (
          <li key={r.slug}>
            <a href={recipePath(locale, r.slug)} className={`font-medium ${link}`}>{r.title}</a>
            <p className="text-sm text-muted-foreground">{r.description}</p>
          </li>
        ))}
      </ul>
    </Document>
  );
}

/** `head` from web().head() (canonical, Markdown alternate) is added by src/html.tsx. */
export function RecipePage({ origin, locale, recipe: r, locales }: { origin: string; locale: Locale; recipe: Recipe; locales: readonly Locale[] }) {
  const t = text[locale], path = (l: Locale) => recipePath(l, r.slug), canonical = origin + path(locale);
  // Number(): on PostgreSQL an integer column may arrive as a string or bigint.
  const answer = r.total_minutes && r.servings ? t.answer(Number(r.total_minutes), Number(r.servings)) : null;
  // Built from the same row as the visible content; states nothing the page does not show.
  const jsonLd = {
    "@context": "https://schema.org", "@type": "Recipe", name: r.title, description: r.description, inLanguage: locale, url: canonical,
    image: r.cover_url ? [r.cover_url] : undefined, datePublished: r.published_at ?? undefined, dateModified: r.updated_at,
    totalTime: r.total_minutes ? `PT${r.total_minutes}M` : undefined, recipeYield: r.servings ? String(r.servings) : undefined,
    recipeIngredient: lines(r.ingredients), recipeInstructions: lines(r.steps).map(step => ({ "@type": "HowToStep", text: step })),
  };
  const head = (
    <>
      <meta name="description" content={r.description ?? ""} />
      <Alternates origin={origin} locales={locales} path={path} />
      <OpenGraph type="article" url={canonical} locale={locale} locales={locales} title={r.title} description={r.description} image={r.cover_url} />
      {/* `<` is escaped so admin-authored text cannot close the script element. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </>
  );
  return (
    <Document locale={locale} title={`${r.title} | ${t.site}`} head={head}>
      <Switcher locales={locales} path={path} current={locale} />
      <p className="mt-2 text-sm"><a href={`/${locale}/`} className={link}>{t.all}</a></p>
      <article>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">{r.title}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{r.description}</p>
        {r.cover_url ? <img src={r.cover_url} alt={r.title ?? ""} className="mt-4 w-full rounded-xl object-cover" /> : null}
        {/* Short answer block: one question and a one-sentence answer that search and answer engines can quote. */}
        {answer ? <section id="quick-answer" className="mt-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10"><h2 className="font-semibold">{t.how}</h2><p>{answer}</p></section> : null}
        <h2 className="mt-4 text-lg font-semibold">{t.ingredients}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">{lines(r.ingredients).map((item, i) => <li key={i}>{item}</li>)}</ul>
        <h2 className="mt-4 text-lg font-semibold">{t.steps}</h2>
        <ol className="steps mt-2 space-y-1 pl-5">{lines(r.steps).map((step, i) => <li key={i}>{step}</li>)}</ol>
      </article>
      {/* An island: this static button is complete markup; src/client/page.js loads src/client/save.tsx when it nears
          the viewport or is first used, and that hydrates it. Without JavaScript the recipe above is the whole page. */}
      <div data-island="save" data-props={JSON.stringify({ slug: r.slug, label: { save: t.save, saved: t.saved } })} className="mt-4">
        <SaveButton label={t.save} />
      </div>
    </Document>
  );
}

/** The save button, rendered by the server and hydrated by the island with the same props. */
export function SaveButton({ label, saved, busy, onClick }: { label: string; saved?: boolean; busy?: boolean; onClick?: () => void }) {
  return (
    <button type="button" aria-pressed={saved} disabled={busy} onClick={onClick}
      className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50">
      {label}
    </button>
  );
}
