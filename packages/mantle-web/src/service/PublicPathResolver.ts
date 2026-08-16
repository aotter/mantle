import { toUrlLocale, type Entry } from "@aotter/mantle-spec";

export function entrySlug(entry: { id: string; data: Record<string, unknown> }): string {
  const fromData = entry.data["slug"];
  if (typeof fromData === "string" && /^[a-z0-9][a-z0-9-]*$/.test(fromData)) {
    return fromData;
  }
  return entry.id;
}

export function entryPublicPath(entry: Entry): string {
  const slug = entrySlug(entry);
  if (entry.locale) return `/${toUrlLocale(entry.locale)}/${entry.collection}/${slug}`;
  return `/${entry.collection}/${slug}`;
}

/**
 * Resolves a public URL path for an entry, given the consumer's
 * collection→URL configuration. One source of truth for both the
 * router (URL → collection/slug lookup) and outbound URL emission
 * (sitemap, hreflang siblings, SEO canonical).
 *
 * The resolver's `forEntry` returns `null` when:
 *   - the entry's collection has no public URL (e.g. parent `posts`
 *     surfaces only via `post-translations` children)
 *   - the entry has no slug AND no canonical id-based URL pattern is
 *     configured for the collection
 *
 * Pure path math — no I/O. Lives in `domain/service/`.
 */
export interface CollectionRoute {
  /** URL segment for entries of this collection.
   *
   *   - non-empty string: `/{locale}/{segment}/{slug}` (e.g. `posts`)
   *   - empty string:     `/{locale}/{slug}` (entries directly under locale)
   *   - null:             collection has no public URL
   */
  readonly segment: string | null;
  /** When the entry's slug equals this value, collapse the URL to
   *  `/{locale}` (no trailing segment + slug). Used for home pages
   *  that live in a translations collection. */
  readonly homeSlug?: string;
}

export interface PublicPathResolverConfig {
  readonly collectionRoutes: Readonly<Record<string, CollectionRoute>>;
}

export interface PublicPathResolver {
  /** Returns `/{locale}/{segment}/{slug}` style path, or `null` if the
   *  entry has no public URL under this configuration. */
  forEntry(entry: Entry): string | null;
  /** Returns the configured route for `collection`, or `undefined` if
   *  the collection isn't mapped. */
  routeFor(collection: string): CollectionRoute | undefined;
}

export function createPublicPathResolver(
  config: PublicPathResolverConfig,
): PublicPathResolver {
  const routes = config.collectionRoutes;
  return {
    forEntry(entry: Entry): string | null {
      const route = routes[entry.collection];
      if (!route || route.segment === null) return null;
      const slug = entrySlug({ id: entry.id, data: entry.data });
      const locale = entry.locale ? toUrlLocale(entry.locale) : "";
      const localePrefix = locale ? `/${locale}` : "";
      if (route.homeSlug && slug === route.homeSlug) {
        return localePrefix || "/";
      }
      const segment = route.segment;
      return segment ? `${localePrefix}/${segment}/${slug}` : `${localePrefix}/${slug}`;
    },
    routeFor(collection: string): CollectionRoute | undefined {
      return routes[collection];
    },
  };
}
