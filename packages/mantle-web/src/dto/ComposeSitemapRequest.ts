import type { Entry } from "@aotter/mantle-spec";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";

export interface ComposeSitemapRequest {
  readonly site: WebSiteConfig;
  /** Map storage row → one or more public routes. Returning `null` skips. */
  readonly pathFor?: (entry: Entry) => string | readonly string[] | null;
  /** Public routes without a backing Entry, such as home and collection lists. */
  readonly additionalPaths?: readonly string[];
  /** Caps the SQL read + memory cost. Defaults to
   *  SITEMAP_MAX_URLS_DEFAULT (50,000 — the sitemap-protocol per-file
   *  ceiling). */
  readonly maxUrls?: number;
}
