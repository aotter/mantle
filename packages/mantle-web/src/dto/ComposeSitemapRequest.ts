import type { Entry } from "@aotter/mantle-spec";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";

export interface ComposeSitemapRequest {
  readonly site: WebSiteConfig;
  /** Ordered Schema tables whose public routes are serialized. */
  readonly collections: readonly string[];
  /** Map storage row → one or more public routes. Returning `null` skips. */
  readonly pathFor?: (entry: Entry) => string | readonly string[] | null;
  /** Public routes without a backing Entry, such as home and collection lists. */
  readonly additionalPaths?: readonly string[];
  /** Entries per part (default 2,000, bounded by the reader's byte budget).
   * Follow nextCursor or serve the sitemap index to retain all URLs. */
  readonly maxUrls?: number;
  readonly cursor?: string;
  /** Fields needed by a custom pathFor; omission preserves full entry data.
   * The default mapper only reads slug and projects automatically. */
  readonly dataFields?: readonly string[];
}
