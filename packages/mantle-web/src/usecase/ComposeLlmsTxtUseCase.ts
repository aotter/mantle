import type { Entry } from "@aotter/mantle-spec";
import type { EntryReader } from "@aotter/mantle-runtime";
import type { PublicPathResolver } from "../service/PublicPathResolver.js";
import { serializeLlmsTxt } from "../service/MarkdownSerializer.js";
import type { ComposeLlmsTxtRequest } from "../dto/ComposeLlmsTxtRequest.js";
import { readPublishedAcrossCollections } from "../service/PublishedCollectionPager.js";

/** Compose one bounded discovery page; callers must expose nextCursor. */
export class ComposeLlmsTxtUseCase {
  constructor(
    private readonly reader: EntryReader,
    private readonly paths: PublicPathResolver | null,
  ) {}

  async execute(request: ComposeLlmsTxtRequest): Promise<{ body: string | null; nextCursor?: string } | null> {
    if (!this.paths) return null;
    const page = await readPublishedAcrossCollections(this.reader, request.collections, {
      locale: request.locale,
      includeUnlocalized: request.includeUnlocalized,
      cursor: request.cursor,
      limit: request.limit,
    });
    const bodies = (request.locales ?? [request.locale ?? ""]).map((locale) => serializeLlmsTxt({
      site: request.site,
      locale,
      entriesByCollection: groupByCollection(request.locales
        ? page.rows.filter((entry) => !entry.locale || entry.locale === locale)
        : page.rows),
      pathFor: (entry) => request.pathFor ? request.pathFor(entry, locale) : this.paths!.forEntry(entry),
    })).filter((body): body is string => body !== null);
    return { body: bodies.length ? bodies.join("\n---\n\n") : null, nextCursor: page.nextCursor };
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
