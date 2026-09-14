import type { WebSiteConfig } from "../model/WebSiteConfig.js";
import type { SeoMeta } from "../model/SeoMeta.js";

/**
 * Request DTO for `RenderListLiveUseCase` — renders a collection's
 * list page from current DB state on demand (no KV read).
 */
export interface RenderListLiveRequest {
  /** Forward continuation returned by the previous page. Defaults to 50 entries. */
  readonly cursor?: string;
  readonly limit?: number;
  /** Adapter/host-owned URL mapping; templates own visible navigation. */
  readonly pathForPage?: (cursor: string) => string;
  readonly collection: string;
  readonly locale: string;
  /** DB locale filter; null for non-localized collections mounted under a locale URL. */
  readonly contentLocale?: string | null;
  readonly site: WebSiteConfig;
  readonly seo?: SeoMeta;
}
