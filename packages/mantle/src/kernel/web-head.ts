/** HTML head formatting loads only when the application asks for head tags. */
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function headTags(canonical: string, row: Record<string, unknown>, markdown: boolean, locales?: readonly string[]): string {
  let tags = '<link rel="canonical" href="' + escape(canonical) + '">';
  if (markdown) tags += '<link rel="alternate" type="text/markdown" href="' + escape(canonical + ".md") + '">';
  if (locales?.[0]) tags += '<link rel="alternate" hreflang="' + escape(locales[0]) + '" href="' + escape(canonical) + '">';
  for (const key of Object.keys(row)) if (key.endsWith("_lat") && typeof row[key] === "number" && typeof row[key.slice(0, -4) + "_lng"] === "number") { tags += '<meta name="geo.position" content="' + escape(row[key]) + ";" + escape(row[key.slice(0, -4) + "_lng"]) + '">'; break; }
  return tags;
}
