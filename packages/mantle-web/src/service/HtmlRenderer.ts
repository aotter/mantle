import type { Entry } from "@aotter/mantle-spec";
import type {
  EntryTemplate,
  ListTemplate,
  TemplateRegistry,
} from "../model/TemplateRegistry.js";
import type { SeoMeta } from "../model/SeoMeta.js";
import type { WebSiteConfig } from "../model/WebSiteConfig.js";
import type { MediaAsset } from "@aotter/mantle-runtime";

/**
 * Pure render functions over the consumer-supplied template registry.
 * Request-time public and preview renderers share this template lookup
 * and doctype concatenation so the contract stays single-sourced
 * — adding a doctype mode, an OG-meta wrapper, or a per-collection
 * pre/post hook is one edit. No I/O; no DB; no env access.
 */
const DEFAULT_DOCTYPE = "<!doctype html>";

export interface RenderEntryArgs {
  readonly entry: Entry;
  readonly site: WebSiteConfig;
  readonly templates: TemplateRegistry;
  /** Defaults to `<!doctype html>`. Pipelines that want the
   *  upper-case `<!DOCTYPE html>\n` shape pass it explicitly. */
  readonly doctype?: string;
  readonly mediaAssets?: ReadonlyMap<string, MediaAsset>;
  /** Optional pre-composed SEO/AEO block. Threaded into the
   *  `EntryContext.seo` field so templates can emit `<SeoTags
   *  seo={seo}/>` inside `<head>`. Renderers that skip composition
   *  leave it undefined — opt-out templates keep working. */
  readonly seo?: SeoMeta;
}

/** Returns the full HTML doc (doctype + body) or `null` if no entry
 *  template is registered for `entry.collection`. */
export function renderEntryHtml(args: RenderEntryArgs): string | null {
  const tpl: EntryTemplate | undefined = args.templates.getEntryTemplate(
    args.entry.collection,
  );
  if (!tpl) return null;
  return (args.doctype ?? DEFAULT_DOCTYPE) +
    tpl({
      entry: args.entry,
      site: args.site,
      mediaAssets: args.mediaAssets,
      seo: args.seo,
    });
}

export interface RenderListArgs {
  readonly nextPageUrl?: string;
  readonly collection: string;
  readonly locale: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly site: WebSiteConfig;
  readonly templates: TemplateRegistry;
  readonly doctype?: string;
  readonly mediaAssets?: ReadonlyMap<string, MediaAsset>;
  readonly seo?: SeoMeta;
}

/** Returns the full HTML doc or `null` if no list template is
 *  registered for `collection`. */
export function renderListHtml(args: RenderListArgs): string | null {
  const tpl: ListTemplate | undefined = args.templates.getListTemplate(args.collection);
  if (!tpl) return null;
  return (args.doctype ?? DEFAULT_DOCTYPE) +
    tpl({
      nextPageUrl: args.nextPageUrl,
      collection: args.collection,
      locale: args.locale,
      entries: args.entries,
      site: args.site,
      mediaAssets: args.mediaAssets,
      seo: args.seo,
    });
}
