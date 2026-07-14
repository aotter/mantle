/**
 * Mime-accept grammar for `MediaPurposePolicy.required`.
 *
 * Each entry of `required` is parsed as one of:
 *   - a full mime type:           `"image/jpeg"`, `"image/avif"`
 *   - a comma-list of full mimes: `"image/jpg,image/png"` (either is OK)
 *   - a shorthand subtype:        `"webp"` → `"image/webp"`, `"jpg"` → `"image/jpeg"`
 *
 * Whitespace around commas and around full entries is tolerated; the
 * grammar mirrors the HTML `<input accept="...">` attribute editors
 * already know. Each entry yields a non-empty *acceptable mime set*
 * for one slot. **Slot order is only used for per-slot mime coverage.
 * Variant role (`primary` / `alternate`) is declared independently
 * per variant by the agent; the use case enforces exactly one
 * primary, but does not bind primary to slot 0.** This matters for
 * back-compat: alpha.14 fixtures such as
 * `["image/avif", "image/webp", "image/jpeg"]` declare avif at slot 0
 * yet ship jpeg as the `<img>` fallback (`role: "primary"`).
 *
 * Per-asset, the agent picks ONE mime per slot from the slot's
 * acceptable set and chooses which of those is the primary. Repeatable
 * benefit: a `product-cover` purpose declared as
 * `["image/jpg,image/png", "webp", "avif"]` accepts a transparent
 * PNG primary (logos / icons) or an opaque JPEG primary (photos)
 * under the same purpose name — no per-purpose split, no forced jpeg
 * flatten that loses alpha.
 *
 * Validation:
 *   - Each entry must yield ≥1 mime after parsing.
 *   - Mime sets across slots MUST NOT overlap (otherwise variant→slot
 *     mapping is ambiguous at upload-policy enforcement time).
 *   - `maxBytes` MUST cover every expanded mime (not the literal
 *     `required[i]` string).
 *
 * See aotter/mantle#282 for the motivating editor-uploads-PNG-as-
 * transparent-asset case.
 */

/** Shorthand → full-mime expansion. Lowercase keys; alias forms
 *  collapse to the canonical mime (`jpg` / `jpeg` / `image/jpg` →
 *  `image/jpeg`). */
const SHORTHAND_TO_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  "image/jpg": "image/jpeg",
  png: "image/png",
  "image/png": "image/png",
  webp: "image/webp",
  "image/webp": "image/webp",
  avif: "image/avif",
  "image/avif": "image/avif",
  gif: "image/gif",
  "image/gif": "image/gif",
  svg: "image/svg+xml",
  "image/svg+xml": "image/svg+xml",
  "image/svg": "image/svg+xml",
};

/**
 * Parse one `required[i]` entry into its acceptable mime set.
 * Returns a deduped, order-preserving list (so error messages /
 * tool descriptions show the entry the way the consumer wrote it).
 *
 * Throws nothing — invalid tokens are returned as-is and the
 * validator's allowlist check flags them downstream. This keeps the
 * parser pure data-shape; semantic validation lives one layer up.
 */
export function parseMimeAccept(entry: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entry.split(",")) {
    const tok = raw.trim().toLowerCase();
    if (!tok) continue;
    const expanded = SHORTHAND_TO_MIME[tok] ?? tok;
    if (!seen.has(expanded)) {
      seen.add(expanded);
      out.push(expanded);
    }
  }
  return out;
}

/**
 * Expand a policy's `required` into per-slot mime sets. Slot ordering
 * is preserved as the consumer wrote it. Variant role (primary /
 * alternate / fallback) is declared independently per variant — see
 * the file header. Returns a `[slot][mime]` matrix.
 */
export function expandPolicyRequired(
  required: readonly string[],
): readonly (readonly string[])[] {
  return required.map(parseMimeAccept);
}

