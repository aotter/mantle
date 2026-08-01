import type { SchemaManifest } from "@aotter/mantle-spec";
import type { EntryReader } from "../../domain/port/EntryReader.js";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { TemplateRegistry } from "../../domain/model/TemplateRegistry.js";
import type { PublicPathResolver } from "../../domain/service/PublicPathResolver.js";
import { joinParentIfTranslation } from "../../domain/service/io/JoinedEntryReader.js";
import { renderEntryHtml } from "../../domain/service/HtmlRenderer.js";
import type { RenderEntryLiveRequest } from "../dto/render/RenderEntryLiveRequest.js";
import {
  composeSeoIfPathed,
  type ComposeEntrySeoMetaUseCase,
} from "./ComposeEntrySeoMetaUseCase.js";
import { resolveMediaAssetsForEntries } from "../../domain/service/io/MediaAssetReferences.js";

/**
 * Render a single entry from current DB state. Used by adapter live-
 * dev routes (`MANTLE_LOCAL_DEV=1`) to bypass the KV cache and pick up
 * template / chrome edits without re-running the publish pipeline.
 *
 * When the runtime was built with a `publicPathResolver`, the SEO/AEO
 * meta block is composed and threaded into `EntryContext.seo` — so
 * live-rendered HTML carries the same meta KV-cached HTML does.
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
    private readonly mediaAssets: MediaAssetRepository | null = null,
  ) {}

  async execute(request: RenderEntryLiveRequest): Promise<string | null> {
    const status = "published";
    const raw = await this.reader.readBySlug({
      collection: request.collection,
      slug: request.slug,
      locale: request.locale,
      status,
    });
    if (!raw) return null;
    const entry = await joinParentIfTranslation(this.reader, this.schemas, raw, {
      parentStatus: status,
    });
    const seo = await composeSeoIfPathed(this.composeSeo, this.paths, entry, request.site);
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
