/** /llms.txt and /sitemap.xml bodies; loaded only when an index is requested, so page Workers do not pay for it at startup. */
const escape = (v: unknown) =>
  String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const label = (v: unknown) =>
  String(v)
    .replace(/[\r\n]/g, " ")
    .replace(/[\\[\]]/g, "\\$&");
const size = (s: string) => new TextEncoder().encode(s).length;

/** A W3C datetime (a date, or a date and time with a zone) that names a real instant. */
const datetime = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(v) &&
  !Number.isNaN(Date.parse(v));

export async function webIndex(
  sitemap: boolean,
  options: {
    readonly origin: string;
    readonly title: string;
    readonly description: string;
    readonly sitemap?: readonly string[];
  },
  pages: readonly {
    readonly path: string;
    readonly page: {
      readonly view: string;
      readonly list?: string;
      readonly markdown?: string;
      readonly lastmod?: string;
    };
  }[],
  list: (view: string, cursor?: string) => Promise<{ rows: Record<string, unknown>[]; nextCursor?: string }>,
  validUrl: (path: string, row: Record<string, unknown>, view: string) => string | undefined,
): Promise<string> {
  const cap = sitemap ? 50000 : 5000,
    limit = sitemap ? 50 * 1024 * 1024 : 1024 * 1024;
  const start = sitemap
      ? '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
      : "# " + label(options.title) + "\n\n> " + label(options.description) + "\n\n## Pages\n\n",
    end = sitemap ? "</urlset>" : "\n";
  const links: string[] = [];
  let visited = 0,
    requests = 0,
    bytes = size(start + end);
  if (bytes > limit) throw new TypeError("Web index header exceeds its byte limit.");
  /** Adds a line unless it would exceed the byte limit. */
  const push = (line: string) => {
    const length = size(line);
    if (bytes + length > limit) return false;
    bytes += length;
    links.push(line);
    return true;
  };
  const item = (url: string, lastmod?: unknown) =>
    "<url><loc>" + escape(url) + "</loc>" + (datetime(lastmod) ? "<lastmod>" + lastmod + "</lastmod>" : "") + "</url>";
  // Static paths come first and count against the same scan and byte limits as rows.
  const origin = new URL(options.origin).origin;
  if (sitemap)
    for (const path of options.sitemap ?? [])
      if (visited++ >= cap || !push(item(origin + path))) return start + links.join("") + end;
  pagesLoop: for (const entry of pages) {
    if (!entry.page.list) continue;
    let cursor: string | undefined;
    do {
      if (requests >= (sitemap ? 100 : 10)) break pagesLoop;
      requests++;
      const page = await list(entry.page.list, cursor);
      for (const row of page.rows) {
        if (visited++ >= cap) break pagesLoop;
        const url = validUrl(entry.path, row, entry.page.view);
        if (!url) continue;
        // llms.txt links the Markdown alternate, unless the list row shows this page has none.
        const markdown = entry.page.markdown && row[entry.page.markdown] !== null ? ".md" : "";
        const line = sitemap
          ? item(url, entry.page.lastmod && row[entry.page.lastmod])
          : "- [" + label(row.title ?? url) + "](" + url + markdown + "): " + label(row.description ?? "") + "\n";
        if (!push(line)) break pagesLoop;
      }
      if (visited >= cap) break pagesLoop;
      cursor = page.nextCursor;
    } while (cursor);
  }
  return start + links.join("") + end;
}
