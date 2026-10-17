/** /llms.txt and /sitemap.xml bodies; loaded only when an index is requested, so page Workers do not pay for it at startup. */
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const label = (v: unknown) => String(v).replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, "\\$&");
const size = (s: string) => new TextEncoder().encode(s).length;

export async function webIndex(
  sitemap: boolean,
  options: { readonly title: string; readonly description: string },
  pages: readonly { readonly path: string; readonly page: { readonly view: string; readonly list?: string } }[],
  list: (view: string, cursor?: string) => Promise<{ rows: Record<string, unknown>[]; nextCursor?: string }>,
  validUrl: (path: string, row: Record<string, unknown>, view: string) => string | undefined,
): Promise<string> {
  const cap = sitemap ? 50000 : 5000, limit = sitemap ? 50 * 1024 * 1024 : 1024 * 1024;
  const start = sitemap ? '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' : "# " + label(options.title) + "\n\n> " + label(options.description) + "\n\n## Pages\n\n", end = sitemap ? "</urlset>" : "\n";
  const links: string[] = []; let visited = 0, requests = 0, bytes = size(start + end); if (bytes > limit) throw new TypeError("Web index header exceeds its byte limit.");
  pagesLoop: for (const entry of pages) {
    if (!entry.page.list) continue;
    let cursor: string | undefined;
    do {
      if (requests >= (sitemap ? 100 : 10)) break pagesLoop; requests++;
      const page = await list(entry.page.list, cursor);
      for (const row of page.rows) { if (visited++ >= cap) break pagesLoop; const url = validUrl(entry.path, row, entry.page.view); if (!url) continue; const line = sitemap ? "<url><loc>" + escape(url) + "</loc></url>" : "- [" + label(row.title ?? url) + "](" + url + "): " + label(row.description ?? "") + "\n"; const length = size(line); if (bytes + length > limit) break pagesLoop; bytes += length; links.push(line); }
      if (visited >= cap) break pagesLoop;
      cursor = page.nextCursor;
    } while (cursor);
  }
  return start + links.join("") + end;
}
