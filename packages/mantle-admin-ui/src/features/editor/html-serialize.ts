/** Treat visually empty contenteditable HTML as an empty stored string. */
export function serializeHtml(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
  return text === "" ? "" : html;
}

export function escapeHtml(value: string): string {
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

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

export function htmlImage(url: string, alt: string): string {
  return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}" />`;
}

export function videoEmbed(rawUrl: string): string {
  const url = parseUrl(rawUrl);
  if (!url) return `<a href="${escapeAttribute(rawUrl)}">${escapeHtml(rawUrl)}</a>`;
  const youtube = youtubeId(url);
  if (youtube) {
    return `<iframe src="https://www.youtube.com/embed/${youtube}" title="YouTube" loading="lazy" allowfullscreen></iframe>`;
  }
  const dailymotion = dailymotionId(url);
  if (dailymotion) {
    return `<iframe src="https://www.dailymotion.com/embed/video/${dailymotion}" title="Dailymotion" loading="lazy" allowfullscreen></iframe>`;
  }
  return `<a href="${escapeAttribute(url.toString())}">${escapeHtml(url.toString())}</a>`;
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
