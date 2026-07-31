import { toUrlLocale, type Entry } from "@aotter/mantle-spec";

/**
 * KV key derivation. Centralised so the publish pipeline (writer) and
 * the public router (reader) agree on one shape; changing the layout
 * is a single-file edit.
 *
 *   - `entry:html:{locale}/{collection}/{slug}` — pre-rendered HTML
 *   - `entry:md:{locale}/{collection}/{slug}`   — markdown mirror
 *   - `list:html:{locale}/{collection}`         — collection index
 *   - `llms:{locale}`                            — /{locale}/llms.txt
 *   - `llms:root:v2`                             — /llms.txt (cross-locale aggregate)
 *
 * Non-localized entries use empty-string locale (`entry:html:/posts/abc`).
 * The root /llms.txt uses an explicit versioned `:root:v2` suffix instead of an
 * empty one because `wrangler kv bulk put` silently drops keys ending
 * in `:` (caught in CI on commit 93c10ef).
 *
 * Pure path math — no I/O. Lives in `domain/service/` so any layer
 * can call it without dragging an adapter dep.
 */
export function entrySlug(entry: { id: string; data: Record<string, unknown> }): string {
  const fromData = entry.data["slug"];
  if (typeof fromData === "string" && /^[a-z0-9][a-z0-9-]*$/.test(fromData)) {
    return fromData;
  }
  return entry.id;
}

export function entryHtmlKey(entry: Entry): string {
  const slug = entrySlug(entry);
  const locale = entry.locale ? toUrlLocale(entry.locale) : "";
  return `entry:html:${locale}/${entry.collection}/${slug}`;
}

export function entryMarkdownKey(entry: Entry): string {
  const slug = entrySlug(entry);
  const locale = entry.locale ? toUrlLocale(entry.locale) : "";
  return `entry:md:${locale}/${entry.collection}/${slug}`;
}

export function listHtmlKey(collection: string, locale: string): string {
  const urlLocale = locale ? locale.toLowerCase() : "";
  return `list:html:${urlLocale}/${collection}`;
}

export function llmsTxtKey(locale: string): string {
  // v2 abandons alpha.58's TTL-less root values, which cannot be repaired
  // until another publish happens. Locale keys already rewrite on publish.
  return locale ? `llms:${locale.toLowerCase()}` : "llms:root:v2";
}

export function entryPublicPath(entry: Entry): string {
  const slug = entrySlug(entry);
  if (entry.locale) return `/${toUrlLocale(entry.locale)}/${entry.collection}/${slug}`;
  return `/${entry.collection}/${slug}`;
}

/**
 * Build the entry HTML key from URL-side parts. The router has the
 * (collection, locale, slug) tuple from path params; reconstructing
 * a partial `Entry` just to call `entryHtmlKey` is bug-bait. Use
 * this helper instead.
 *
 * Pass `locale = ""` for non-localized entries (matches publish
 * pipeline semantic where non-localized entries write to
 * `entry:html:/{collection}/{slug}`).
 */
export function entryHtmlKeyFromParts(
  collection: string,
  locale: string,
  slug: string,
): string {
  const urlLocale = locale ? locale.toLowerCase() : "";
  return `entry:html:${urlLocale}/${collection}/${slug}`;
}

export function entryMarkdownKeyFromParts(
  collection: string,
  locale: string,
  slug: string,
): string {
  const urlLocale = locale ? locale.toLowerCase() : "";
  return `entry:md:${urlLocale}/${collection}/${slug}`;
}
