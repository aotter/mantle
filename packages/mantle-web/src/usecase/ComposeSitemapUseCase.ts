import type { Entry } from "@aotter/mantle-spec";
import type { EntryReader } from "@aotter/mantle-runtime";
import { entryPublicPath } from "../service/PublicPathResolver.js";
import { serializeSitemap } from "../service/SitemapSerializer.js";
import type { ComposeSitemapRequest } from "../dto/ComposeSitemapRequest.js";

/**
 * Compose `sitemap.xml` from every published entry across all
 * collections + locales. Result is XML text; consumer routes it as
 * `application/xml`. See ComposeSitemapRequest for the pathFor +
 * maxUrls knobs.
 */
export const SITEMAP_MAX_URLS_DEFAULT = 50000;

export class ComposeSitemapUseCase {
  constructor(private readonly reader: EntryReader) {}

  async execute(request: ComposeSitemapRequest): Promise<string> {
    const cap = request.maxUrls ?? SITEMAP_MAX_URLS_DEFAULT;
    const all = await this.reader.readPublished({ limit: cap });
    const mapper = request.pathFor ?? entryPublicPath;
    const entries: { entry?: Entry; path: string }[] = [];
    const seen = new Set<string>();
    const push = (path: string, entry?: Entry): void => {
      if (seen.has(path)) return;
      seen.add(path);
      entries.push(entry ? { entry, path } : { path });
    };
    for (const path of request.additionalPaths ?? []) push(path);
    for (const e of all) {
      const mapped = mapper(e);
      for (const path of mapped === null ? [] : typeof mapped === "string" ? [mapped] : mapped) {
        push(path, e);
      }
    }
    return serializeSitemap({ site: request.site, entries });
  }
}
