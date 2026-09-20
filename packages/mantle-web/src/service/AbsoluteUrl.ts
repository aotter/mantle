/**
 * Absolutize a path against a `SiteConfig.origin`. Single chokepoint
 * so trailing-slash handling is consistent across every URL the SDK
 * emits — sitemap, llms.txt mirrors, SEO canonical, hreflang siblings.
 *
 * Two divergent strip behaviors used to live across the codebase
 * (`/\/$/` vs `/\/+$/`); both flow through here now.
 *
 * Empty `origin` returns the path unchanged — useful for tests and
 * for templates that intentionally emit relative URLs. Already-
 * absolute `path` (http(s)://...) returns unchanged.
 */
const TRAILING_SLASHES = /\/+$/;

export function absoluteUrl(origin: string, path: string): string {
  if (!origin) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const cleanOrigin = origin.replace(TRAILING_SLASHES, "");
  if (!path) return cleanOrigin;
  return `${cleanOrigin}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Append `.md` before any query string / hash. Used by the SEO
 *  composer + sitemap to derive markdown-mirror URLs without
 *  mangling query params. */
export function appendMarkdownExt(absoluteOrPath: string): string {
  const match = /^([^?#]*)(.*)$/.exec(absoluteOrPath);
  if (!match) return `${absoluteOrPath}.md`;
  return `${match[1]}.md${match[2]}`;
}
