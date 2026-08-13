import type { Entry, SiteConfig } from "@aotter/mantle-spec";
import type {
  EntryTemplate,
  ListTemplate,
  TemplateRegistry,
} from "../model/TemplateRegistry.js";
import type { SeoMeta } from "../model/SeoMeta.js";
import type { MediaAsset } from "../port/MediaStorage.js";

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
  readonly site: SiteConfig;
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
  return injectTrackingTags(
    (args.doctype ?? DEFAULT_DOCTYPE) +
      tpl({
        entry: args.entry,
        site: args.site,
        mediaAssets: args.mediaAssets,
        seo: args.seo,
      }),
    args.site,
  );
}

export interface RenderListArgs {
  readonly collection: string;
  readonly locale: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly site: SiteConfig;
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
  return injectTrackingTags(
    (args.doctype ?? DEFAULT_DOCTYPE) +
      tpl({
        collection: args.collection,
        locale: args.locale,
        entries: args.entries,
        site: args.site,
        mediaAssets: args.mediaAssets,
        seo: args.seo,
      }),
    args.site,
  );
}

export function renderTrackingTagsHtml(site: SiteConfig): string {
  const ga4Id = normalizeGa4MeasurementId(site.ga4MeasurementId);
  const pixelId = normalizeFacebookPixelId(site.facebookPixelId);
  const parts: string[] = [];
  if (ga4Id) {
    parts.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4Id}"></script>`);
    parts.push(`<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga4Id}');</script>`);
  }
  if (pixelId) {
    parts.push(`<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s);}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixelId}');fbq('track','PageView');</script>`);
    parts.push(`<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1"/></noscript>`);
  }
  return parts.length > 0 ? `\n${parts.join("\n")}\n` : "";
}

function injectTrackingTags(html: string, site: SiteConfig): string {
  const tags = renderTrackingTagsHtml(site);
  if (!tags) return html;
  const headClose = /<\/head>/i;
  if (headClose.test(html)) return html.replace(headClose, `${tags}</head>`);
  const bodyOpen = /<body[^>]*>/i;
  if (bodyOpen.test(html)) return html.replace(bodyOpen, (match) => `${match}${tags}`);
  return `${tags}${html}`;
}

export function normalizeGa4MeasurementId(value: string | undefined): string | null {
  const trimmed = value?.trim().toUpperCase() ?? "";
  return /^G-[A-Z0-9]{4,32}$/.test(trimmed) ? trimmed : null;
}

export function normalizeFacebookPixelId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^[0-9]{5,32}$/.test(trimmed) ? trimmed : null;
}
