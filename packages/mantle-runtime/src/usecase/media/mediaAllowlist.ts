/**
 * Closed mime allowlist for v0.1.x media uploads. Adapter authors
 * cannot extend this without a grammar-revise round.
 *
 * SVG is intentionally absent from the always-on set — object stores
 * don't sanitize and a passthrough SVG can carry inline scripts. SVG
 * uploads are only accepted when the adapter wires the use case with
 * `allowSvg: true`, typically from a `MEDIA_ALLOW_SVG=1` env opt-in.
 */
export const MEDIA_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;

export const MEDIA_SVG_MIME = "image/svg+xml" as const;

export type MediaMimeType = (typeof MEDIA_MIME_ALLOWLIST)[number] | typeof MEDIA_SVG_MIME;

export function isAllowedMime(mime: string, allowSvg: boolean): boolean {
  if (mime === MEDIA_SVG_MIME) return allowSvg;
  return (MEDIA_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

/** Upload-capability TTL: 15 minutes. Bearer URL is short-lived. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Map a mime type to a conventional file extension for object key
 *  construction. Extension is purely cosmetic in R2 — server-side
 *  serving never infers content-type from the key. */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/gif":
      return "gif";
    case MEDIA_SVG_MIME:
      return "svg";
    default:
      return "bin";
  }
}
