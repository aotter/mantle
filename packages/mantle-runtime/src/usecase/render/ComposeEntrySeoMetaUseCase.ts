import type { Entry, SiteConfig } from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import {
  composeEntrySeoMeta,
  type SeoMeta,
  type SiblingTranslation,
} from "../../domain/service/SeoMetaComposer.js";
import type { PublicPathResolver } from "../../domain/service/PublicPathResolver.js";
import { readEntryBySlug } from "../../domain/service/io/PublishedEntries.js";
import type { ComposeEntrySeoMetaRequest } from "../dto/render/ComposeEntrySeoMetaRequest.js";

/**
 * Compose the SEO/AEO meta block for an entry. Reads sibling
 * translations from the DB (same collection, same slug, other
 * locales) so hreflang links are accurate; calls the pure composer
 * for the rest.
 *
 * "Same collection" is a deliberate simplification — works correctly
 * for `post-translations`-style design where each locale has its own
 * row in the same collection. Sites that split locales across
 * collections (`posts-en`, `posts-zh`) need a custom resolver — out
 * of scope for v0.1.
 *
 * Sibling lookup is one indexed `readEntryBySlug` per non-current
 * locale — O(locales), not O(collection). Runs in parallel via
 * `Promise.all`.
 */
export class ComposeEntrySeoMetaUseCase {
  constructor(private readonly db: DatabaseDriver) {}

  async execute(request: ComposeEntrySeoMetaRequest): Promise<SeoMeta> {
    const { entry, site, paths, type } = request;
    const publicPath = paths.forEntry(entry) ?? "";
    const siblings = await readSiblings(this.db, entry, site, paths);
    return composeEntrySeoMeta({ entry, site, publicPath, siblings, type });
  }
}

export async function composeSeoIfPathed(
  composer: Pick<ComposeEntrySeoMetaUseCase, "execute">,
  paths: PublicPathResolver | null,
  entry: Entry,
  site: SiteConfig,
): Promise<SeoMeta | undefined> {
  if (!paths?.forEntry(entry)) return undefined;
  return composer.execute({ entry, site, paths });
}

async function readSiblings(
  db: DatabaseDriver,
  current: Entry,
  site: SiteConfig,
  paths: PublicPathResolver,
): Promise<SiblingTranslation[]> {
  const slug = current.data["slug"];
  if (typeof slug !== "string" || slug.length === 0) return [];
  if (site.locales.length <= 1) return [];
  const currentKey = current.locale?.toLowerCase();
  const targetLocales = site.locales.filter((l) => l.toLowerCase() !== currentKey);
  const lookups = await Promise.all(
    targetLocales.map((locale) =>
      readEntryBySlug(db, {
        collection: current.collection,
        slug,
        locale,
        status: "published",
      }).then((e) => ({ locale, entry: e })),
    ),
  );
  const out: SiblingTranslation[] = [];
  for (const { locale, entry } of lookups) {
    if (!entry) continue;
    const path = paths.forEntry(entry);
    if (path) out.push({ locale, publicPath: path });
  }
  return out;
}
