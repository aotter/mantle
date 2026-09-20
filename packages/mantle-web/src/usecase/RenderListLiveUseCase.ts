import type { SchemaManifest } from "@aotter/mantle-spec";
import { joinParentForList, type EntryReader } from "@aotter/mantle-runtime";
import type { TemplateRegistry } from "../model/TemplateRegistry.js";
import { renderListHtml } from "../service/HtmlRenderer.js";
import type { RenderListLiveRequest } from "../dto/RenderListLiveRequest.js";
import {
  resolveMediaAssetsForEntries,
  type MediaAssetResolver,
} from "../service/io/MediaAssetReferences.js";

/**
 * Render a collection's list page from current DB state. Sibling to
 * `RenderEntryLiveUseCase` for the post-list / page-list surfaces.
 * Returns `null` when no list template is registered for the
 * collection — adapters map to 404.
 *
 * Each entry is run through the parent-join (ADR-0010) before being
 * passed to the list template, so list-item fields living on the
 * parent (e.g. `posts.coverUrl` for a translations-list) reach the
 * template the same way they do on the entry detail page.
 */
export class RenderListLiveUseCase {
  constructor(
    private readonly reader: EntryReader,
    private readonly templates: TemplateRegistry,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly mediaAssets: MediaAssetResolver | null = null,
  ) {}

  async execute(request: RenderListLiveRequest): Promise<{ html: string; nextCursor?: string } | null> {
    const page = await this.reader.readPublishedPage({
      cursor: request.cursor,
      limit: request.limit,
      collection: request.collection,
      locale: request.contentLocale === undefined ? request.locale : request.contentLocale,
    });
    const entries = await joinParentForList(this.reader, this.schemas, page.rows, {
      parentStatus: "published",
    });
    const mediaAssets = await resolveMediaAssetsForEntries(this.mediaAssets, entries);
    const html = renderListHtml({
      nextPageUrl: page.nextCursor ? request.pathForPage?.(page.nextCursor) : undefined,
      collection: request.collection,
      locale: request.locale,
      entries,
      site: request.site,
      templates: this.templates,
      mediaAssets,
      seo: request.seo,
    });
    return html === null ? null : { html, nextCursor: page.nextCursor };
  }
}
