/**
 * Inject a preview banner just inside the rendered `<body>`. Used by
 * the request-time `?preview=1` route so authors can see in-progress
 * drafts with a visible "this isn't published" mark.
 *
 * The injection looks for the first `<body...>` opening tag and
 * appends `banner` immediately after it. Documents without a body tag
 * (fragments, partial templates) fall through unchanged — the caller
 * already validated the renderer produced a full HTML document, so a
 * missing body is a contract violation, not user input.
 *
 * Pure string transformation. Lives in `domain/service/` so the
 * regex (and any future DOM-safer replacement) stays in one place.
 */
const BODY_OPEN = /<body([^>]*)>/;

export function injectPreviewBanner(html: string, banner: string): string {
  return html.replace(BODY_OPEN, `<body$1>${banner}`);
}

/**
 * Build the SDK's default preview banner markup. Both `status` and
 * `slug` are HTML-escaped — `status` is a closed enum so escaping is
 * defense-in-depth, but `slug` is caller-supplied and a slug
 * containing `<script>` would otherwise inject script into the
 * preview surface.
 */
export function defaultPreviewBanner(status: string, slug: string): string {
  return `<div class="preview-banner">Preview · ${escapeHtml(status)} · ${escapeHtml(slug)}</div>`;
}
import { escapeHtml } from "./HtmlEscaping.js";
