/**
 * The pure head formatter for application-owned pages. It imports only the escape helper: an application that only
 * formats its own head does not load `web()`'s serving code, and `web()` alone does not load this.
 */
import { escape } from "./web-escape.js";

/** What an application-owned page puts in its head: values it already has. Absent, null or empty values emit no tag. */
export interface PageHeadOptions {
  title: string;
  /** `og:title` when it differs from `<title>`, such as a title without the site name; `title` when omitted. */
  ogTitle?: string | null;
  description?: string | null;
  /** The canonical URL, on the application's configured origin. */
  url: string;
  image?: string | null;
  siteName?: string | null;
  /** The page's language, a BCP 47 tag such as `zh-TW`. */
  locale?: string | null;
  /** Open Graph type; `website` when omitted. */
  type?: "website" | "article";
  /** Each language the page exists in, this one included, and its URL. */
  alternates?: Readonly<Record<string, string>>;
  /** The URL for `hreflang="x-default"`. */
  xDefault?: string | null;
  /** The URL of the page's Markdown alternate. */
  markdown?: string | null;
  /** JSON-LD the application built from the page's row; Core only serializes it. */
  jsonLd?: object | readonly object[] | null;
}

/**
 * Application seam: applications depend on this. Do not remove or narrow it because Core has no internal use
 * (CONTRIBUTING.md, "Application seams").
 *
 * Head tags for an application-owned page: title, description, canonical, Markdown and language alternates, Open Graph,
 * Twitter card and JSON-LD. Every value is escaped; JSON-LD escapes `<`, so stored text cannot close the script element.
 */
export function pageHead(options: PageHeadOptions): string {
  const attr = (value: unknown) => '"' + escape(value) + '"';
  /** `<name key value-attribute="value">`, or nothing when the value is absent or empty. */
  const tag = (name: string, key: string, value: unknown, attribute = "content") =>
    value == null || value === "" ? "" : "<" + name + " " + key + " " + attribute + "=" + attr(value) + ">";
  const link = (rel: string, href: unknown) => tag("link", rel, href, "href");
  const og = (property: string, value: unknown) => tag("meta", "property=" + attr("og:" + property), value);
  /** Open Graph writes `zh-TW` as `zh_TW`. */
  const ogLocale = (locale: string) => locale.replaceAll("-", "_");
  const { title, description, url, image, locale } = options;
  const alternates = Object.entries(options.alternates ?? {});
  return [
    title ? "<title>" + escape(title) + "</title>" : "",
    tag("meta", 'name="description"', description),
    link('rel="canonical"', url),
    link('rel="alternate" type="text/markdown"', options.markdown),
    ...alternates.map(([lang, href]) => link('rel="alternate" hreflang=' + attr(lang), href)),
    link('rel="alternate" hreflang="x-default"', options.xDefault),
    og("type", options.type ?? "website"),
    og("url", url),
    og("title", options.ogTitle || title),
    og("description", description),
    og("site_name", options.siteName),
    og("locale", locale && ogLocale(locale)),
    ...alternates.filter(([lang]) => lang !== locale).map(([lang]) => og("locale:alternate", ogLocale(lang))),
    og("image", image),
    tag("meta", 'name="twitter:card"', image ? "summary_large_image" : "summary"),
    options.jsonLd
      ? '<script type="application/ld+json">' + JSON.stringify(options.jsonLd).replace(/</g, "\\u003c") + "</script>"
      : "",
  ].join("");
}
