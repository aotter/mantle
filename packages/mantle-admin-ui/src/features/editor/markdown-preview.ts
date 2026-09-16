import { Marked, type Tokens } from "marked";

/**
 * Admin live preview for `x-mcp-hint: markdown`.
 *
 * `marked` is a small GFM parser (not a WYSIWYG stack). Raw HTML is
 * escaped so the preview stays Markdown-shaped; javascript: URLs are
 * neutralized. Public pages still render through `@aotter/mantle-web`.
 */
const parser = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Link["tokens"]): string } }, token: Tokens.Link): string {
      const body = this.parser.parseInline(token.tokens);
      const url = safePreviewUrl(token.href);
      const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : "";
      return `<a href="${escapeAttr(url)}"${titleAttr} rel="noreferrer noopener">${body}</a>`;
    },
    image({ href, title, text }: Tokens.Image): string {
      const url = safePreviewUrl(href);
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(url)}" alt="${escapeAttr(text)}"${titleAttr} />`;
    },
  },
});

export function renderMarkdownPreview(source: string): string {
  return parser.parse(source, { async: false }) as string;
}

export function safePreviewUrl(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  if (
    trimmed.startsWith("#")
    || trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
  ) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return trimmed;
    }
  } catch {
    if (!trimmed.includes(":")) return trimmed;
  }
  return "#";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
