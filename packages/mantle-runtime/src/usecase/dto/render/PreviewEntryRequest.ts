import type { SiteConfig } from "@aotter/mantle-spec";

/**
 * Request DTO for `PreviewEntryUseCase`. Looks up the entry,
 * preferring draft → published → archived; renders via the registered template; injects a
 * preview banner.
 */
export interface PreviewEntryRequest {
  readonly collection: string;
  readonly slug: string;
  readonly locale: string;
  readonly site: SiteConfig;
}
