/**
 * Composed SEO + AEO meta block surfaced to entry / list templates
 * via `EntryContext.seo` / `ListContext.seo`. Built by
 * `composeEntrySeoMeta` (pure) — see `domain/service/SeoMetaComposer`.
 *
 * "AEO-friendly" means: in addition to the standard SEO tags, every
 * entry page carries a `<link rel="alternate" type="text/markdown"
 * href="...md">` pointing at the publish-pipeline-emitted markdown
 * mirror. LLM crawlers can grab the markdown directly — no HTML
 * scraping, no DOM parsing.
 */
export interface SeoMeta {
  /** Absolute canonical URL — `<link rel="canonical">`. */
  readonly canonical: string;
  /** Absolute URL of the markdown mirror — `<link rel="alternate"
   *  type="text/markdown">`. AEO-critical. */
  readonly alternateMarkdown: string;
  /** One per locale this entry has a translation in, plus an
   *  `x-default` row when the site has multiple locales. */
  readonly hreflangs: ReadonlyArray<{ readonly locale: string; readonly href: string }>;
  /** `<meta name="description">`. `null` to skip. */
  readonly description: string | null;
  /** Open Graph block. */
  readonly og: {
    readonly type: "article" | "website";
    readonly url: string;
    readonly title: string;
    readonly siteName: string;
    readonly description: string | null;
    readonly image: string | null;
    readonly locale: string;
  };
  /** Twitter card block. */
  readonly twitter: {
    readonly card: "summary" | "summary_large_image";
    readonly title: string;
    readonly description: string | null;
    readonly image: string | null;
  };
  /** JSON-LD object — emitted as `<script type="application/ld+json">`.
   *  `null` skips emission. */
  readonly jsonLd: object | null;
}
