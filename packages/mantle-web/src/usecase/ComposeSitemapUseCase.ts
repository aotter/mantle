import type { Entry } from "@aotter/mantle-spec";
import type { EntryReader } from "@aotter/mantle-runtime";
import { entryPublicPath } from "../service/PublicPathResolver.js";
import { serializeSitemap, serializeSitemapIndex } from "../service/SitemapSerializer.js";
import type { ComposeSitemapRequest } from "../dto/ComposeSitemapRequest.js";
import { readPublishedAcrossCollections } from "../service/PublishedCollectionPager.js";

/** Entries per sitemap part; the protocol ceiling remains 50,000 URLs. */
export const SITEMAP_MAX_URLS_DEFAULT = 2000;

export class ComposeSitemapUseCase {
  constructor(private readonly reader: EntryReader) {}

  async execute(request: ComposeSitemapRequest): Promise<{ body: string; nextCursor?: string }> {
    const cap = request.maxUrls ?? SITEMAP_MAX_URLS_DEFAULT;
    const page = await readPublishedAcrossCollections(this.reader, request.collections, {
      limit: cap, cursor: request.cursor,
      dataFields: request.dataFields ?? (request.pathFor ? undefined : ["slug"]),
    });
    const mapper = request.pathFor ?? entryPublicPath;
    const entries: { entry?: Entry; path: string }[] = [];
    const seen = new Set<string>();
    const push = (path: string, entry?: Entry): void => {
      if (seen.has(path)) return;
      seen.add(path);
      entries.push(entry ? { entry, path } : { path });
    };
    if (!request.cursor) for (const path of request.additionalPaths ?? []) push(path);
    for (const e of page.rows) {
      const mapped = mapper(e);
      for (const path of mapped === null ? [] : typeof mapped === "string" ? [mapped] : mapped) {
        push(path, e);
      }
    }
    if (entries.length > 50_000) throw new Error("sitemap part exceeds 50,000 URLs; reduce maxUrls");
    const body = serializeSitemap({ site: request.site, entries });
    if (new TextEncoder().encode(body).byteLength > 50 * 1024 * 1024) {
      throw new Error("sitemap part exceeds 50 MiB; reduce maxUrls");
    }
    return { body, nextCursor: page.nextCursor };
  }

  /** Walk bounded metadata pages to derive the exact part boundaries. No entry cache.
   * ponytail: O(N) metadata reads per index MISS; persist part boundaries only if this dominates. */
  async index(request: ComposeSitemapRequest, partPath: (cursor?: string) => string): Promise<string> {
    const paths = [partPath()];
    let cursor: string | undefined;
    do {
      const page = await readPublishedAcrossCollections(this.reader, request.collections, {
        limit: request.maxUrls ?? SITEMAP_MAX_URLS_DEFAULT,
        dataFields: request.dataFields ?? (request.pathFor ? undefined : ["slug"]),
        cursor,
      });
      cursor = page.nextCursor;
      if (cursor) paths.push(partPath(cursor));
      if (paths.length > 50_000) throw new Error("sitemap index exceeds 50,000 parts");
    } while (cursor);
    const body = serializeSitemapIndex(request.site, paths);
    if (new TextEncoder().encode(body).byteLength > 50 * 1024 * 1024) throw new Error("sitemap index exceeds 50 MiB");
    return body;
  }
}
