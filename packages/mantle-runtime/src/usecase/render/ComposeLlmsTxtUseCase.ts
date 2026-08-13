import type { Entry } from "@aotter/mantle-spec";
import type { EntryReader } from "../../domain/port/EntryReader.js";
import type { PublicPathResolver } from "../../domain/service/PublicPathResolver.js";
import { serializeLlmsTxt } from "../../domain/service/MarkdownSerializer.js";
import type { ComposeLlmsTxtRequest } from "../dto/render/ComposeLlmsTxtRequest.js";

/**
 * Compose a `/llms.txt` body from currently-published entries.
 *
 *   - locale: string  → entries with `data.locale === locale`
 *   - locale: null    → non-localized entries only. Consumers that want
 *                       a cross-locale aggregate at the root URL should
 *                       iterate site.locales themselves and concat.
 */
export class ComposeLlmsTxtUseCase {
  constructor(
    private readonly reader: EntryReader,
    private readonly paths: PublicPathResolver | null,
  ) {}

  async execute(request: ComposeLlmsTxtRequest): Promise<string | null> {
    if (!this.paths) return null;
    const query = (locale: string | null) => this.reader.readPublished({
      locale,
      collection: request.collection,
    });
    const entries = request.locale !== null && request.includeUnlocalized
      ? (await Promise.all([query(request.locale), query(null)])).flat()
      : await query(request.locale);
    const grouped = groupByCollection(entries);
    return serializeLlmsTxt({
      site: request.site,
      locale: request.locale ?? "",
      entriesByCollection: grouped,
      pathFor: request.pathFor ?? ((entry) => this.paths!.forEntry(entry)),
    });
  }
}

function groupByCollection(entries: readonly Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = out.get(e.collection);
    if (arr) arr.push(e);
    else out.set(e.collection, [e]);
  }
  return out;
}
