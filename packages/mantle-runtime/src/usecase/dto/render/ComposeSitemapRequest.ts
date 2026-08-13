import type { Entry, SiteConfig } from "@aotter/mantle-spec";

export interface ComposeSitemapRequest {
  readonly site: SiteConfig;
  /** Map storage row → one or more public routes. Returning `null` skips. */
  readonly pathFor?: (entry: Entry) => string | readonly string[] | null;
  /** Public routes without a backing Entry, such as home and collection lists. */
  readonly additionalPaths?: readonly string[];
  /** Caps the SQL read + memory cost. Defaults to
   *  SITEMAP_MAX_URLS_DEFAULT (50,000 — the sitemap-protocol per-file
   *  ceiling). */
  readonly maxUrls?: number;
}
