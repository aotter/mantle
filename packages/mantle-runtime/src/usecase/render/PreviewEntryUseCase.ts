import type { ContentState, Entry, SchemaManifest } from "@aotter/mantle-spec";
import type { EntryReader } from "../../domain/port/EntryReader.js";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type { TemplateRegistry } from "../../domain/model/TemplateRegistry.js";
import type { PublicPathResolver } from "../../domain/service/PublicPathResolver.js";
import { joinParentIfTranslation } from "../../domain/service/io/JoinedEntryReader.js";
import { renderEntryHtml } from "../../domain/service/HtmlRenderer.js";
import {
  defaultPreviewBanner,
  injectPreviewBanner,
} from "../../domain/service/PreviewBanner.js";
import type { PreviewEntryRequest } from "../dto/render/PreviewEntryRequest.js";
import {
  composeSeoIfPathed,
  type ComposeEntrySeoMetaUseCase,
} from "./ComposeEntrySeoMetaUseCase.js";
import { resolveMediaAssetsForEntries } from "../../domain/service/io/MediaAssetReferences.js";

/** Default fallback: prefer drafts, fall back to published, then
 *  archived. Authors typically open `?preview=1` to see WIP. */
const DEFAULT_PREVIEW_STATUS_ORDER: ReadonlyArray<ContentState> = [
  "draft",
  "published",
  "archived",
];

/**
 * Render an entry with a preview banner. Walks the default status order until a
 * matching row is found, renders via the registered template, then
 * injects the banner just inside `<body>`. Returns `null` when no
 * matching row exists or no template is registered.
 *
 * Composes SEO/AEO meta when the runtime was built with a
 * `publicPathResolver` — preview pages match the meta the published
 * version would carry, so authors see real shape during review.
 */
export class PreviewEntryUseCase {
  constructor(
    private readonly reader: EntryReader,
    private readonly templates: TemplateRegistry,
    private readonly paths: PublicPathResolver | null,
    private readonly composeSeo: Pick<ComposeEntrySeoMetaUseCase, "execute">,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly mediaAssets: MediaAssetRepository | null = null,
  ) {}

  async execute(request: PreviewEntryRequest): Promise<string | null> {
    let raw: Entry | null = null;
    for (const status of DEFAULT_PREVIEW_STATUS_ORDER) {
      raw = await this.reader.readBySlug({
        collection: request.collection,
        slug: request.slug,
        locale: request.contentLocale === undefined ? request.locale : request.contentLocale,
        status,
      });
      if (raw) break;
    }
    if (!raw) return null;
    // Preview can show drafts; parent lookup intentionally omits status
    // filter so a draft translation can still preview against its
    // already-published parent. RequestPublishUseCase enforces the
    // published-parent invariant at publish time.
    const entry = await joinParentIfTranslation(this.reader, this.schemas, raw);
    const seo = await composeSeoIfPathed(this.composeSeo, this.paths, entry, request.site, request);
    const mediaAssets = await resolveMediaAssetsForEntries(this.mediaAssets, [entry]);
    const html = renderEntryHtml({
      entry,
      site: request.site,
      templates: this.templates,
      mediaAssets,
      seo,
    });
    if (html === null) return null;
    const banner = defaultPreviewBanner(entry.status, request.slug);
    return injectPreviewBanner(html, banner);
  }
}
