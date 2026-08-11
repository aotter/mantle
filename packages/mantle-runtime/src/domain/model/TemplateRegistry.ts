import type { Entry, SiteConfig } from "@aotter/mantle-spec";
import type { SeoMeta } from "./SeoMeta.js";
import type { MediaAsset } from "../port/MediaStorage.js";

/**
 * Render-pipeline types + consumer-supplied template registry.
 *
 * The runtime stays string-typed — templates return complete HTML
 * body strings (no doctype prefix; the HTML renderer adds it) so
 * the runtime carries no JSX dependency. Consumers using JSX in
 * their public surface (Hono + hono/jsx) call their JSX → string
 * function before the template returns.
 *
 * Schemas without a registered entry/list template still get
 * markdown / `llms.txt` mirrors — the HTML surfaces are simply
 * skipped (per ADR-0009-extended: the SDK ships zero opinionated
 * templates).
 *
 * `seo` is populated when the renderer is given a composed SeoMeta
 * block — templates render `<SeoTags seo={seo} />` (or read fields
 * directly) when present. Renderers that skip composition leave
 * `seo` undefined so opt-out templates don't break.
 *
 * Lives in `domain/model/` because runtime render use cases and
 * consumer-supplied templates both reference it.
 */
export interface EntryContext {
  readonly entry: Entry;
  readonly site: SiteConfig;
  readonly mediaAssets?: ReadonlyMap<string, MediaAsset>;
  readonly seo?: SeoMeta;
}

export interface ListContext {
  readonly collection: string;
  readonly locale: string;
  readonly entries: readonly Entry[];
  readonly site: SiteConfig;
  readonly mediaAssets?: ReadonlyMap<string, MediaAsset>;
  readonly seo?: SeoMeta;
}

export type EntryTemplate = (ctx: EntryContext) => string;
export type ListTemplate = (ctx: ListContext) => string;

export class TemplateRegistry {
  private readonly entries = new Map<string, EntryTemplate>();
  private readonly lists = new Map<string, ListTemplate>();

  registerEntryTemplate(collection: string, t: EntryTemplate): void {
    this.entries.set(collection, t);
  }

  registerListTemplate(collection: string, t: ListTemplate): void {
    this.lists.set(collection, t);
  }

  getEntryTemplate(collection: string): EntryTemplate | undefined {
    return this.entries.get(collection);
  }

  getListTemplate(collection: string): ListTemplate | undefined {
    return this.lists.get(collection);
  }
}
