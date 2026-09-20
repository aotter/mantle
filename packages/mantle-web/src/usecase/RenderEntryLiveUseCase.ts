import type { SchemaManifest } from "@aotter/mantle-spec";
import {
  joinParentIfTranslation,
  type EntryReader,
} from "@aotter/mantle-runtime";
import type { TemplateRegistry } from "../model/TemplateRegistry.js";
import type { PublicPathResolver } from "../service/PublicPathResolver.js";
import { renderEntryHtml } from "../service/HtmlRenderer.js";
import type { RenderEntryLiveRequest } from "../dto/RenderEntryLiveRequest.js";
import {
  composeSeoIfPathed,
  type ComposeEntrySeoMetaUseCase,
} from "./ComposeEntrySeoMetaUseCase.js";
import {
  resolveMediaAssetsForEntries,
  type MediaAssetResolver,
} from "../service/io/MediaAssetReferences.js";

/**
 * Render a single entry from current canonical DB state. Public and
 * live-dev routes share this path; adapters decide the HTTP cache policy.
 *
 * When the runtime was built with a `publicPathResolver`, the SEO/AEO
 * meta block is composed and threaded into `EntryContext.seo` — so
 * rendered HTML includes canonical and sibling metadata.
 *
 * When the entry belongs to a collection with `translates.parent`,
 * the parent's data is merged into the translation's data (ADR-0010)
 * before rendering, so template fields living on the parent
 * (`coverUrl`, `authorId`, `publishedAt`) reach the template.
 *
 * Returns the full HTML document, or `null` when:
 *   - no entry matches `(collection, slug, locale, status)`
 *   - the collection has no registered entry template
 * Adapters map `null` to a 404 response.
 */
export class RenderEntryLiveUseCase {
  constructor(
    private readonly reader: EntryReader,
    private readonly templates: TemplateRegistry,
    private readonly paths: PublicPathResolver | null,
    private readonly composeSeo: Pick<ComposeEntrySeoMetaUseCase, "execute">,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly mediaAssets: MediaAssetResolver | null = null,
  ) {}

  async execute(request: RenderEntryLiveRequest): Promise<string | null> {
    const status = "published";
    const raw = await this.reader.readBySlug({
      collection: request.collection,
      slug: request.slug,
      locale: request.contentLocale === undefined ? request.locale : request.contentLocale,
      status,
    });
    if (!raw) return null;
    const entry = await joinParentIfTranslation(this.reader, this.schemas, raw, {
      parentStatus: status,
    });
    const seo = await composeSeoIfPathed(this.composeSeo, this.paths, entry, request.site, request);
    const mediaAssets = await resolveMediaAssetsForEntries(this.mediaAssets, [entry]);
    return renderEntryHtml({
      entry,
      site: request.site,
      templates: this.templates,
      mediaAssets,
      seo,
    });
  }
}
