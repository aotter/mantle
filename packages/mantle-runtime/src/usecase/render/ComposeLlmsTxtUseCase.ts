import type { Entry } from "@aotter/mantle-spec";
import type { EntryReader } from "../../domain/port/EntryReader.js";
import { serializeLlmsTxt } from "../../domain/service/MarkdownSerializer.js";
import type { ComposeLlmsTxtRequest } from "../dto/render/ComposeLlmsTxtRequest.js";

/**
 * Compose a `/llms.txt` body from currently-published entries.
 *
 *   - locale: string  → entries with `data.locale === locale`
 *   - locale: null    → non-localized entries only (publish-pipeline
 *                       semantic; matches what HtmlPublishOrchestrator
 *                       writes to the versioned root key on a non-localized
 *                       publish). Consumers that want a cross-locale
 *                       aggregate at the root URL should iterate
 *                       site.locales themselves and concat.
 */
export class ComposeLlmsTxtUseCase {
  constructor(private readonly reader: EntryReader) {}

  async execute(request: ComposeLlmsTxtRequest): Promise<string> {
    const entries = await this.reader.readPublished({ locale: request.locale });
    const grouped = groupByCollection(entries);
    return serializeLlmsTxt({
      site: request.site,
      locale: request.locale ?? "",
      entriesByCollection: grouped,
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
