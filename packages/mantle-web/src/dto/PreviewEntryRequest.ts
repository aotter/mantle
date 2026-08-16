import type { WebSiteConfig } from "../model/WebSiteConfig.js";
import type { SiblingTranslation } from "../service/SeoMetaComposer.js";

/**
 * Request DTO for `PreviewEntryUseCase`. Looks up the entry,
 * preferring draft → published → archived; renders via the registered template; injects a
 * preview banner.
 */
export interface PreviewEntryRequest {
  readonly collection: string;
  readonly slug: string;
  readonly locale: string;
  readonly contentLocale?: string | null;
  readonly publicPath?: string;
  readonly publicLocale?: string;
  readonly siblings?: ReadonlyArray<SiblingTranslation>;
  readonly site: WebSiteConfig;
}
