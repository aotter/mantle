import type { Entry } from "@aotter/mantle-spec";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";
import type { PublicPathResolver } from "../service/PublicPathResolver.js";
import type { SiblingTranslation } from "../service/SeoMetaComposer.js";

/**
 * Request DTO for `ComposeEntrySeoMetaUseCase`. Caller passes the
 * entry, the site, and the resolver; the use case figures out
 * sibling translations for hreflang.
 */
export interface ComposeEntrySeoMetaRequest {
  readonly entry: Entry;
  readonly site: WebSiteConfig;
  readonly paths: PublicPathResolver;
  readonly type?: "article" | "website";
  readonly publicPath?: string;
  readonly publicLocale?: string;
  readonly siblings?: ReadonlyArray<SiblingTranslation>;
}
