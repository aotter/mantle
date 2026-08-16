import type { SiteConfig } from "@aotter/mantle-spec";

/** Site fields consumed by public document composition. */
export type WebSiteConfig = Pick<
  SiteConfig,
  | "title"
  | "description"
  | "origin"
  | "locales"
  | "canonicalLocale"
  | "brand"
  | "icons"
  | "ga4MeasurementId"
  | "facebookPixelId"
>;
