import type { Entry, SiteConfig } from "@aotter/mantle-spec";
import { absoluteUrl } from "./AbsoluteUrl.js";

/**
 * Hreflang alternates are deferred to v0.1.x (need cross-locale entry
 * pairing first); only minimal `loc + lastmod` shipped.
 *
 * Entries arrive pre-mapped from storage row to public path — the
 * caller (`ComposeSitemapUseCase`) decides how a (collection, slug,
 * locale) row surfaces under the consumer's routing.
 */
export interface SitemapEntry {
  readonly entry?: Entry;
  readonly path: string;
}

export interface SitemapInput {
  readonly site: SiteConfig;
  readonly entries: readonly SitemapEntry[];
}

export function serializeSitemap(input: SitemapInput): string {
  const { site, entries } = input;
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`);
  for (const { entry, path } of entries) {
    const loc = absoluteUrl(site.origin ?? "", path);
    out.push("  <url>");
    out.push(`    <loc>${escapeXml(loc)}</loc>`);
    if (entry?.updatedAt) {
      out.push(`    <lastmod>${new Date(entry.updatedAt).toISOString()}</lastmod>`);
    }
    out.push("  </url>");
  }
  out.push("</urlset>");
  return out.join("\n") + "\n";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
