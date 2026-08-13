import type { SiteConfig } from "@aotter/mantle-spec";
import type { SeoMeta } from "../../../domain/model/SeoMeta.js";

/**
 * Request DTO for `RenderListLiveUseCase` — renders a collection's
 * list page from current DB state on demand (no KV read).
 */
export interface RenderListLiveRequest {
  readonly collection: string;
  readonly locale: string;
  /** DB locale filter; null for non-localized collections mounted under a locale URL. */
  readonly contentLocale?: string | null;
  readonly site: SiteConfig;
  readonly seo?: SeoMeta;
}
