/** Keep the encoding declaration before injected metadata and scripts. */
export function insertAppHead(html: string, markup: string): string {
  const head = /<head\b[^>]*>(?:\s*<meta\s+charset\s*=[^>]*>)?/i;
  return head.test(html) ? html.replace(head, start => start + markup) : markup + html;
}
