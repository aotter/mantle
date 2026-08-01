import {
  DiagnosticError,
  runtimeDiagnostic,
  type Entry,
  type SchemaManifest,
  type SiteConfig,
} from "@aotter/mantle-spec";
import type { TemplateRegistry } from "../../domain/model/TemplateRegistry.js";
import type { EntryReader } from "../../domain/port/EntryReader.js";
import type { KvCache } from "../../domain/port/KvCache.js";
import type { MediaAssetRepository } from "../../domain/port/MediaAssetRepository.js";
import type {
  PublishEntryRequest,
  PublishOrchestrator,
} from "../../domain/port/PublishOrchestrator.js";
import {
  entryHtmlKey,
  entryMarkdownKey,
  listHtmlKey,
  llmsTxtKey,
} from "../../domain/service/PublishKeys.js";
import {
  joinParentForList,
  joinParentIfTranslation,
} from "../../domain/service/io/JoinedEntryReader.js";
import { serializeEntryAsMarkdown } from "../../domain/service/MarkdownSerializer.js";
import {
  renderEntryHtml,
  renderListHtml,
} from "../../domain/service/HtmlRenderer.js";
import type { PublicPathResolver } from "../../domain/service/PublicPathResolver.js";
import { resolveMediaAssetsForEntries } from "../../domain/service/io/MediaAssetReferences.js";
import {
  composeSeoIfPathed,
  type ComposeEntrySeoMetaUseCase,
} from "../../usecase/render/ComposeEntrySeoMetaUseCase.js";

/**
 * Structural contract of the llms.txt composer the orchestrator
 * accepts. Kept here (vs. importing the concrete use-case class) so
 * infrastructure doesn't cross the `infrastructure→usecase` boundary
 * — the runtime assembly root wires in `ComposeLlmsTxtUseCase`,
 * which satisfies this shape.
 */
export interface LlmsTxtComposer {
  execute(args: {
    readonly site: SiteConfig;
    readonly locale: string | null;
  }): Promise<string>;
}

/**
 * `HtmlPublishOrchestrator` — the publish pipeline. Renders + writes
 * to `KvCache`:
 *   1. Entry HTML (if a template is registered for the collection)
 *   2. Entry `.md` mirror (if the entry has a `content` field)
 *   3. Collection list HTML for the entry's locale
 *   4. `/llms.txt` for the entry's locale (composed by ComposeLlmsTxtUseCase)
 *
 * Idempotent — invoking twice with the same entry id is safe; KV
 * writes overwrite. Non-localized entries publish under empty-string
 * locale.
 */
const DEFAULT_DOCTYPE = "<!DOCTYPE html>\n";

export class HtmlPublishOrchestrator implements PublishOrchestrator {
  constructor(
    private readonly reader: EntryReader,
    private readonly kv: KvCache,
    private readonly paths: PublicPathResolver | null,
    private readonly composeSeo: Pick<ComposeEntrySeoMetaUseCase, "execute">,
    private readonly composeLlmsTxt: LlmsTxtComposer,
    private readonly schemas: ReadonlyMap<string, SchemaManifest>,
    private readonly mediaAssets: MediaAssetRepository | null = null,
  ) {}

  async publish(request: PublishEntryRequest): Promise<void> {
    const raw = await requireEntry(this.reader, request.entryId, "usecase/PublishEntry");
    // Materialize parent fields into the translation's data before
    // rendering (ADR-0010). RequestPublishUseCase has already asserted
    // the parent is published, so a status filter is safe here.
    const entry = await joinParentIfTranslation(this.reader, this.schemas, raw, {
      parentStatus: "published",
    });
    const indexLocale = entry.locale ?? null;
    await Promise.all([
      this.renderEntry(entry, request.site, request.templates, DEFAULT_DOCTYPE),
      this.renderList(entry.collection, indexLocale, request.site, request.templates, DEFAULT_DOCTYPE),
      this.renderLlmsTxt(indexLocale, request.site),
      ...(indexLocale === null ? [] : [this.kv.delete(llmsTxtKey(""))]),
    ]);
  }

  async unpublish(request: PublishEntryRequest): Promise<void> {
    const entry = await requireEntry(
      this.reader,
      request.entryId,
      "usecase/UnpublishEntryCache",
    );
    const indexLocale = entry.locale ?? null;
    await Promise.all([
      this.kv.delete(entryHtmlKey(entry)),
      this.kv.delete(entryMarkdownKey(entry)),
      this.renderList(entry.collection, indexLocale, request.site, request.templates, DEFAULT_DOCTYPE),
      this.renderLlmsTxt(indexLocale, request.site),
      ...(indexLocale === null ? [] : [this.kv.delete(llmsTxtKey(""))]),
    ]);
  }

  async invalidateAll(): Promise<void> {
    await Promise.all([
      this.deletePrefix("entry:html:"),
      this.deletePrefix("list:html:"),
      this.deletePrefix("llms:"),
    ]);
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.kv.list(prefix, cursor);
      await Promise.all(page.keys.map((key) => this.kv.delete(key)));
      cursor = page.cursor;
    } while (cursor);
  }

  private async renderEntry(
    entry: Entry,
    site: SiteConfig,
    templates: TemplateRegistry,
    doctype: string,
  ): Promise<void> {
    const seo = await composeSeoIfPathed(this.composeSeo, this.paths, entry, site);
    const mediaAssets = await resolveMediaAssetsForEntries(this.mediaAssets, [entry]);
    const html = renderEntryHtml({ entry, site, templates, doctype, mediaAssets, seo });
    if (html !== null) {
      await this.kv.put(entryHtmlKey(entry), html);
    }
    const md = serializeEntryAsMarkdown(entry);
    if (md) {
      await this.kv.put(entryMarkdownKey(entry), md);
    }
  }

  private async renderList(
    collection: string,
    locale: string | null,
    site: SiteConfig,
    templates: TemplateRegistry,
    doctype: string,
  ): Promise<void> {
    const raw = await this.reader.readPublished({ locale, collection });
    const entries = await joinParentForList(this.reader, this.schemas, raw, {
      parentStatus: "published",
    });
    const mediaAssets = await resolveMediaAssetsForEntries(this.mediaAssets, entries);
    const html = renderListHtml({
      collection,
      locale: locale ?? "",
      entries,
      site,
      templates,
      doctype,
      mediaAssets,
    });
    if (html !== null) {
      await this.kv.put(listHtmlKey(collection, locale ?? ""), html);
    }
  }

  private async renderLlmsTxt(locale: string | null, site: SiteConfig): Promise<void> {
    const body = await this.composeLlmsTxt.execute({ site, locale });
    await this.kv.put(llmsTxtKey(locale ?? ""), body);
  }
}

async function requireEntry(
  reader: EntryReader,
  entryId: string,
  pathPrefix: string,
): Promise<Entry> {
  const entry = await reader.readById(entryId);
  if (entry) return entry;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "NOT_FOUND",
      severity: "error",
      path: `${pathPrefix}/${entryId}`,
      value: entryId,
      expected: "id of an existing entry",
      message: `Entry not found: ${entryId}.`,
    }),
  );
}
