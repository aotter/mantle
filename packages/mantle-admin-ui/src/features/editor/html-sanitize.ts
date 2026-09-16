/** Allowlisted HTML sanitizer for the Admin WYSIWYG. Strips scripts,
 *  event handlers, and non-http(s) URLs. Safe to run in Node tests. */

const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "iframe", "img", "li", "mark", "ol", "p", "pre", "s", "span", "strike", "strong",
  "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);

const VOID_TAGS = new Set(["br", "hr", "img"]);

const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "textarea", "xmp"]);

const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "title"]),
  iframe: new Set(["src", "title", "allowfullscreen", "loading", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

const STYLE_TAGS = new Set(["div", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "td", "th"]);

export function isSafeHref(url: string): boolean {
  const value = decodeHtmlEntities(url).trim();
  return /^(https?:|mailto:|\/|#)/i.test(value) && !/[\s<>]/.test(value) && !/^javascript:/i.test(value);
}

export function isSafeImgSrc(url: string): boolean {
  const value = decodeHtmlEntities(url).trim();
  return /^(https?:|\/)/i.test(value) && !/[\s<>]/.test(value);
}

export function isSafeIframeSrc(url: string): boolean {
  const value = decodeHtmlEntities(url).trim();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "www.youtube.com" || host === "youtube.com") {
      return parsed.pathname.startsWith("/embed/");
    }
    if (host === "www.dailymotion.com" || host === "dailymotion.com") {
      return parsed.pathname.startsWith("/embed/video/");
    }
    return false;
  } catch {
    return false;
  }
}

export function sanitizeCssText(style: string): string {
  const allowed: string[] = [];
  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const rawValue = trimmed.slice(colon + 1).trim();
    const value = rawValue.toLowerCase();
    if (/url\s*\(|expression|javascript:/i.test(rawValue)) continue;
    if (property === "text-align" && /^(left|center|right|justify)$/.test(value)) {
      allowed.push(`text-align: ${value}`);
    } else if ((property === "color" || property === "background-color") && isSafeColor(rawValue)) {
      allowed.push(`${property}: ${rawValue}`);
    }
  }
  return allowed.join("; ");
}

export function sanitizeHtml(html: string): string {
  const tokens = html.split(/(<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>)/g);
  const out: string[] = [];
  const stack: string[] = [];
  let skipping: string | null = null;
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith("<!--")) continue;
    const close = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/.exec(token);
    if (close) {
      const tag = close[1]!.toLowerCase();
      if (skipping) {
        if (tag === skipping) skipping = null;
        continue;
      }
      const index = stack.lastIndexOf(tag);
      if (index < 0) continue;
      while (stack.length > index) {
        const open = stack.pop();
        if (open) out.push(`</${open}>`);
      }
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)(\/?)\s*>$/.exec(token);
    if (open) {
      const tag = open[1]!.toLowerCase();
      if (skipping) continue;
      if (SKIP_CONTENT_TAGS.has(tag)) {
        skipping = tag;
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) continue;
      const attrs = serializeAttributes(tag, open[2] ?? "");
      if (tag === "img" && !/\ssrc=/.test(attrs)) continue;
      if (tag === "iframe") {
        if (!/\ssrc=/.test(attrs)) continue;
        out.push(`<iframe${attrs}></iframe>`);
        continue;
      }
      const selfClosing = open[3] === "/" || VOID_TAGS.has(tag);
      out.push(`<${tag}${attrs}>`);
      if (!selfClosing) stack.push(tag);
      continue;
    }
    if (skipping) continue;
    if (token.startsWith("<")) continue;
    out.push(token);
  }
  while (stack.length > 0) {
    const tag = stack.pop();
    if (tag) out.push(`</${tag}>`);
  }
  return normalizeEmpty(out.join(""));
}

function serializeAttributes(tag: string, raw: string): string {
  const allowed = new Set([...(TAG_ATTRS[tag] ?? []), ...(STYLE_TAGS.has(tag) ? ["style"] : [])]);
  const parts: string[] = [];
  const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  let rel = "";
  let target = "";
  while ((match = attrRe.exec(raw))) {
    const name = match[1]!.toLowerCase();
    if (name.startsWith("on") || name.startsWith("xmlns") || name === "srcdoc") continue;
    if (!allowed.has(name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name === "href") {
      if (!isSafeHref(value)) continue;
      parts.push(`href="${escapeAttr(decodeHtmlEntities(value).trim())}"`);
      continue;
    }
    if (name === "src") {
      if (tag === "img" && isSafeImgSrc(value)) {
        parts.push(`src="${escapeAttr(decodeHtmlEntities(value).trim())}"`);
      } else if (tag === "iframe" && isSafeIframeSrc(value)) {
        parts.push(`src="${escapeAttr(decodeHtmlEntities(value).trim())}"`);
      }
      continue;
    }
    if (name === "style") {
      const css = sanitizeCssText(value);
      if (css) parts.push(`style="${escapeAttr(css)}"`);
      continue;
    }
    if (name === "target") {
      if (value === "_blank") target = "_blank";
      continue;
    }
    if (name === "rel") {
      rel = decodeHtmlEntities(value);
      continue;
    }
    if (name === "allowfullscreen") {
      parts.push("allowfullscreen");
      continue;
    }
    if ((name === "colspan" || name === "rowspan" || name === "width" || name === "height") && /^\d+$/.test(value)) {
      parts.push(`${name}="${value}"`);
      continue;
    }
    if (name === "loading" && (value === "lazy" || value === "eager")) {
      parts.push(`loading="${value}"`);
      continue;
    }
    if (name === "alt" || name === "title") {
      parts.push(`${name}="${escapeAttr(value)}"`);
    }
  }
  if (tag === "a" && (target === "_blank" || parts.some((part) => part.startsWith("href=")))) {
    if (target === "_blank") {
      parts.push('target="_blank"');
      const relTokens = new Set(rel.split(/\s+/).filter(Boolean));
      relTokens.add("noopener");
      relTokens.add("noreferrer");
      parts.push(`rel="${escapeAttr([...relTokens].join(" "))}"`);
    } else if (rel) {
      parts.push(`rel="${escapeAttr(rel)}"`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function normalizeEmpty(html: string): string {
  const stripped = html.replace(/<br\s*\/?>/gi, "").replace(/&nbsp;/gi, " ").replace(/<p>\s*<\/p>/gi, "").trim();
  return stripped === "" ? "" : html;
}

function isSafeColor(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0|1|0?\.\d+)\s*\)|[a-z]+)$/i.test(value.trim());
}

export function escapeAttr(value: string): string {
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

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function videoEmbedHtml(rawUrl: string): string {
  const url = parseUrl(rawUrl);
  if (!url) return `<a href="${escapeAttr(rawUrl)}">${escapeAttr(rawUrl)}</a>`;
  const youtube = youtubeId(url);
  if (youtube) {
    return `<iframe src="https://www.youtube.com/embed/${youtube}" title="YouTube" loading="lazy" allowfullscreen></iframe>`;
  }
  const dailymotion = dailymotionId(url);
  if (dailymotion) {
    return `<iframe src="https://www.dailymotion.com/embed/video/${dailymotion}" title="Dailymotion" loading="lazy" allowfullscreen></iframe>`;
  }
  return `<a href="${escapeAttr(url.toString())}">${escapeAttr(url.toString())}</a>`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function youtubeId(url: URL): string | null {
  if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (!url.hostname.includes("youtube.com")) return null;
  if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/").filter(Boolean)[1] ?? null;
  return url.searchParams.get("v");
}

function dailymotionId(url: URL): string | null {
  if (url.hostname === "dai.ly") return url.pathname.split("/").filter(Boolean)[0] ?? null;
  if (!url.hostname.includes("dailymotion.com")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const videoIndex = parts.indexOf("video");
  return videoIndex >= 0 ? (parts[videoIndex + 1] ?? null) : null;
}
