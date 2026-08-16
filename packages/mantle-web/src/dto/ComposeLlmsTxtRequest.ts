import type { Entry } from "@aotter/mantle-spec";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";

export interface ComposeLlmsTxtRequest {
  readonly site: WebSiteConfig;
  /** locale: string → entries with that locale; locale: null →
   *  non-localized only (matches publish-pipeline semantic). */
  readonly locale: string | null;
  /** Include public non-localized entries alongside the requested locale. */
  readonly includeUnlocalized?: boolean;
  /** Optional collection limit used by collection-list markdown mirrors. */
  readonly collection?: string;
  readonly pathFor?: (entry: Entry) => string | null;
}
