import { toUrlLocale, type Entry } from "@aotter/mantle-spec";
import type { SeoMeta } from "../model/SeoMeta.js";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";
import { absoluteUrl, appendMarkdownExt } from "./AbsoluteUrl.js";
import { escapeHtml as escapeAttr } from "./HtmlEscaping.js";
import { getEntryDescription, hasMarkdownBody } from "./MarkdownSerializer.js";

/**
 * Pure composer for SEO + AEO meta blocks emitted on every public
 * entry page. Carries the conventions a consumer otherwise re-invents
 * — canonical, hreflang siblings, the `.md` mirror alternate that
 * lets LLM crawlers grab clean markdown, og: + twitter card, JSON-LD
 * structured data.
 *
 * The composer is pure — no I/O, no DB. The caller resolves the
 * sibling translations (for hreflang) and passes them in. See
 * `ComposeEntrySeoMetaUseCase` for the wired version that does the
 * sibling-read.
 *
 * The shape of the result lives in `domain/model/SeoMeta` so
 * `TemplateRegistry`'s `EntryContext.seo` can reference it without
 * pulling service code into model.
 */
export type { SeoMeta } from "../model/SeoMeta.js";

export interface SiblingTranslation {
  readonly locale: string;
  readonly publicPath: string;
}

export interface ComposeEntrySeoMetaArgs {
  readonly entry: Entry;
  readonly site: WebSiteConfig;
  /** The current entry's public path (already includes locale prefix).
   *  Composer prepends `site.origin` to absolutize. */
  readonly publicPath: string;
  /** Optional sibling translations for hreflang. The current entry's
   *  locale entry is added by the composer if not already present. */
  readonly siblings?: ReadonlyArray<SiblingTranslation>;
  /** og:type. Defaults to `article` when the entry has a `publishedAt`
   *  (or `updatedAt`) field, `website` otherwise. */
  readonly type?: "article" | "website";
  /** Public-route locale for non-localized entries mounted under a locale URL. */
  readonly locale?: string;
}

export function composeEntrySeoMeta(args: ComposeEntrySeoMetaArgs): SeoMeta {
  const { entry, site, publicPath, siblings = [], type } = args;
  const data = entry.data as Record<string, unknown>;
  const canonical = absoluteUrl(site.origin, publicPath);
  const alternateMarkdown = hasMarkdownBody(entry) ? appendMarkdownExt(canonical) : null;

  const title = stringField(data, "title") ?? site.title;
  const description = getEntryDescription(entry) ?? site.description ?? null;
  const image = stringField(data, "coverUrl") ?? stringField(data, "ogImage") ?? null;
  const ogType = type ?? (hasArticleSignal(entry) ? "article" : "website");
  const entryLocale = args.locale ?? entry.locale ?? site.canonicalLocale ?? "en";

  const hreflangs = buildHreflangs({
    site,
    currentLocale: entryLocale,
    currentPublicPath: publicPath,
    siblings,
  });

  return {
    canonical,
    alternateMarkdown,
    hreflangs,
    description: description ?? null,
    og: {
      type: ogType,
      url: canonical,
      title,
      siteName: site.title || site.brand,
      description: description ?? null,
      image,
      locale: entryLocale,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description: description ?? null,
      image,
    },
    jsonLd: buildJsonLd({
      ogType,
      title,
      description,
      canonical,
      image,
      data,
      site,
      locale: entryLocale,
    }),
  };
}

export interface ComposePageSeoMetaArgs {
  readonly site: WebSiteConfig;
  readonly locale: string;
  readonly publicPath: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly markdown: boolean;
  readonly pathForLocale: (locale: string) => string;
}

/** SEO for public home/list pages that are not represented by one Entry. */
export function composePageSeoMeta(args: ComposePageSeoMetaArgs): SeoMeta {
  const { site, locale, publicPath, pathForLocale } = args;
  const canonical = absoluteUrl(site.origin, publicPath);
  const title = args.title ?? site.title;
  const description = args.description ?? site.description ?? null;
  const hreflangs = [
    ...site.locales.map((candidate) => ({
      locale: candidate,
      href: absoluteUrl(site.origin, pathForLocale(candidate)),
    })),
    {
      locale: "x-default",
      href: absoluteUrl(
        site.origin,
        pathForLocale(site.canonicalLocale ?? site.locales[0] ?? locale),
      ),
    },
  ];
  return {
    canonical,
    alternateMarkdown: args.markdown ? appendMarkdownExt(canonical) : null,
    hreflangs,
    description,
    og: {
      type: "website",
      url: canonical,
      title,
      siteName: site.title || site.brand,
      description,
      image: null,
      locale,
    },
    twitter: {
      card: "summary",
      title,
      description,
      image: null,
    },
    jsonLd: buildJsonLd({
      ogType: "website",
      title,
      description,
      canonical,
      image: null,
      data: {},
      site,
      locale,
    }),
  };
}

function buildHreflangs(args: {
  site: WebSiteConfig;
  currentLocale: string;
  currentPublicPath: string;
  siblings: ReadonlyArray<SiblingTranslation>;
}): SeoMeta["hreflangs"] {
  const { site, currentLocale, currentPublicPath, siblings } = args;
  const out: Array<{ locale: string; href: string }> = [];
  const seen = new Set<string>();
  const push = (locale: string, path: string): void => {
    const key = locale.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ locale, href: absoluteUrl(site.origin, path) });
  };
  push(currentLocale, currentPublicPath);
  for (const s of siblings) push(s.locale, s.publicPath);
  // x-default points at the canonical-locale variant when known,
  // falling back to the current entry's URL otherwise. Search engines
  // expect this row alongside the per-locale ones.
  const canonicalSibling = siblings.find(
    (s) => site.canonicalLocale && s.locale.toLowerCase() === site.canonicalLocale.toLowerCase(),
  );
  out.push({
    locale: "x-default",
    href: absoluteUrl(site.origin, canonicalSibling?.publicPath ?? currentPublicPath),
  });
  return out;
}

function buildJsonLd(args: {
  ogType: "article" | "website";
  title: string;
  description: string | null;
  canonical: string;
  image: string | null;
  data: Record<string, unknown>;
  site: WebSiteConfig;
  locale: string;
}): object | null {
  const { ogType, title, description, canonical, image, data, site, locale } = args;
  const publishedAtMs = numericField(data, "publishedAt");
  const updatedAtMs = numericField(data, "updatedAt");
  const base = {
    "@context": "https://schema.org",
    "@type": ogType === "article" ? "Article" : "WebPage",
    headline: title,
    name: title,
    url: canonical,
    description: description ?? undefined,
    image: image ?? undefined,
    inLanguage: locale,
    publisher: site.title || site.brand
      ? {
          "@type": "Organization",
          name: site.title || site.brand,
        }
      : undefined,
    datePublished: publishedAtMs ? new Date(publishedAtMs).toISOString() : undefined,
    dateModified: updatedAtMs ? new Date(updatedAtMs).toISOString() : undefined,
  };
  // Drop undefined keys so JSON.stringify produces a clean object.
  return Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== undefined),
  );
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numericField(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function hasArticleSignal(entry: Entry): boolean {
  return typeof entry.data["publishedAt"] === "number" || hasMarkdownBody(entry);
}

/**
 * Render the SEO meta block as an HTML fragment. Templates embed this
 * verbatim inside `<head>` via `raw(renderSeoTagsHtml(seo))`.
 *
 * Order matters slightly for crawlers — canonical first, alternates
 * (markdown then hreflang) before og:/twitter so the discoverability
 * bones land before the rich-preview block.
 */
export function renderSeoTagsHtml(meta: SeoMeta): string {
  const parts: string[] = [];
  parts.push(`<link rel="canonical" href="${escapeAttr(meta.canonical)}">`);
  if (meta.alternateMarkdown) {
    parts.push(
      `<link rel="alternate" type="text/markdown" href="${escapeAttr(meta.alternateMarkdown)}">`,
    );
  }
  for (const h of meta.hreflangs) {
    parts.push(
      `<link rel="alternate" hreflang="${escapeAttr(h.locale)}" href="${escapeAttr(h.href)}">`,
    );
  }
  if (meta.description) {
    parts.push(`<meta name="description" content="${escapeAttr(meta.description)}">`);
  }
  parts.push(`<meta name="generator" content="mantle">`);
  parts.push(`<meta property="og:type" content="${escapeAttr(meta.og.type)}">`);
  parts.push(`<meta property="og:url" content="${escapeAttr(meta.og.url)}">`);
  parts.push(`<meta property="og:title" content="${escapeAttr(meta.og.title)}">`);
  if (meta.og.siteName) {
    parts.push(`<meta property="og:site_name" content="${escapeAttr(meta.og.siteName)}">`);
  }
  if (meta.og.description) {
    parts.push(
      `<meta property="og:description" content="${escapeAttr(meta.og.description)}">`,
    );
  }
  if (meta.og.image) {
    parts.push(`<meta property="og:image" content="${escapeAttr(meta.og.image)}">`);
  }
  parts.push(`<meta property="og:locale" content="${escapeAttr(toUrlLocale(meta.og.locale))}">`);
  parts.push(`<meta name="twitter:card" content="${escapeAttr(meta.twitter.card)}">`);
  parts.push(`<meta name="twitter:title" content="${escapeAttr(meta.twitter.title)}">`);
  if (meta.twitter.description) {
    parts.push(
      `<meta name="twitter:description" content="${escapeAttr(meta.twitter.description)}">`,
    );
  }
  if (meta.twitter.image) {
    parts.push(`<meta name="twitter:image" content="${escapeAttr(meta.twitter.image)}">`);
  }
  if (meta.jsonLd) {
    parts.push(
      `<script type="application/ld+json">${escapeJsonLd(meta.jsonLd)}</script>`,
    );
  }
  return parts.join("\n");
}

function escapeJsonLd(obj: object): string {
  // `</script>` inside JSON-LD is the only nested-script pitfall;
  // escaping the closing `</` keeps the embedded JSON strict-parseable.
  return JSON.stringify(obj).replace(/<\//g, "<\\/");
}
