import type { Entry } from "@aotter/mantle-spec";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";

export interface ComposeLlmsTxtRequest {
  readonly site: WebSiteConfig;
  /** locale: string → entries with that locale; locale: null →
   *  non-localized only; omitted reads all locales for a root page. */
  readonly locale?: string | null;
  /** Root aggregate: read one canonical page, then expand shared entries per locale. */
  readonly locales?: readonly string[];
  readonly cursor?: string;
  readonly limit?: number;
  /** Include public non-localized entries alongside the requested locale. */
  readonly includeUnlocalized?: boolean;
  /** Ordered Schema tables to publish. */
  readonly collections: readonly string[];
  readonly pathFor?: (entry: Entry, locale: string) => string | null;
}
