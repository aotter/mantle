import { APP_CATALOG_ID } from "./app/bridge.js";
/** Keep the encoding declaration before injected metadata and scripts. */
export function insertAppHead(html: string, markup: string): string {
  const head = /<head\b[^>]*>(?:\s*<meta\s+charset\s*=[^>]*>)?/i;
  return head.test(html) ? html.replace(head, start => start + markup) : markup + html;
}

export const catalogueScript = (catalogue: unknown): string =>
  `<script type="application/json" id="${APP_CATALOG_ID}">${JSON.stringify(catalogue).replace(/</g, "\\u003c")}</script>`;
