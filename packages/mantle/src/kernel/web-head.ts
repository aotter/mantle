/** HTML head formatting loads only when the application asks for head tags. */
import { escape } from "./web-escape.js";
export function headTags(
  canonical: string,
  row: Record<string, unknown>,
  markdown: boolean,
  locales?: readonly string[],
): string {
  let tags = '<link rel="canonical" href="' + escape(canonical) + '">';
  if (markdown) tags += '<link rel="alternate" type="text/markdown" href="' + escape(canonical + ".md") + '">';
  // With several locales the page is one translation; its per-language hreflang is the application's.
  if (locales?.length === 1)
    tags += '<link rel="alternate" hreflang="' + escape(locales[0]) + '" href="' + escape(canonical) + '">';
  for (const key of Object.keys(row))
    if (key.endsWith("_lat") && typeof row[key] === "number" && typeof row[key.slice(0, -4) + "_lng"] === "number") {
      tags +=
        '<meta name="geo.position" content="' + escape(row[key]) + ";" + escape(row[key.slice(0, -4) + "_lng"]) + '">';
      break;
    }
  return tags;
}
