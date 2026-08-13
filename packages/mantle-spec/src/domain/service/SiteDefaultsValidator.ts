import {
  MEDIA_PURPOSE_SLUG_PATTERN,
  type MediaPurposePolicy,
  type SiteIcon,
  type SiteDefaults,
} from "../model/SiteConfig.js";
import {
  expandPolicyRequired,
  parseMimeAccept,
} from "../model/MediaMimeAccept.js";
import {
  canonicalizeLocaleList,
  containsScriptSubtagLocale,
} from "./LocaleCanonicalizer.js";

/**
 * Synchronous fail-fast for `siteDefaults`. Throws
 * `InvalidSiteDefaultsError` when any declared locale fails BCP 47
 * canonicalization. Throws `InvalidMediaPurposesError` when any
 * declared `media.purposes` entry's `name` fails the slug pattern,
 * its `required` mime list is empty, or its `maxBytes` map is
 * missing entries for any required mime. Throws `InvalidSiteIconsError`
 * when a declared site icon cannot be served safely. Brand / title /
 * description / origin are not validated — only the fields whose values
 * carry semantics the runtime depends on.
 *
 * Lives in spec (not runtime) because it's pure validation against
 * the `SiteConfig` contract — no env, no DB. Runtime calls this during
 * `bootInit()` so a typo in `src/mantle/config.ts > siteDefaults` rejects boot
 * before the runtime accepts traffic.
 */
export class InvalidSiteDefaultsError extends Error {
  constructor(public readonly invalidLocales: ReadonlyArray<string>) {
    const hasScriptSubtag = containsScriptSubtagLocale(invalidLocales);
    super(
      `Invalid Mantle locale tag(s) in CmsConfig.siteDefaults.locales: ` +
        invalidLocales.map((s) => `'${s}'`).join(", ") +
        `. Use Mantle v0.1 locale form like 'en' or 'zh-TW' — the canonicalizer ` +
        `accepts mixed case ('zh-tw' / 'ZH_TW'), but the structure must ` +
        `be a 2/3-letter language plus optional 2-letter region. ` +
        (hasScriptSubtag
          ? `Script subtags such as 'zh-Hant', 'zh-Hans', 'sr-Latn', or 'sr-Cyrl' are valid BCP 47 but intentionally unsupported in Mantle v0.1; use region tags such as 'zh-TW' for Traditional Chinese or 'zh-CN' for Simplified Chinese. `
          : "") +
        `See ADR-0010 / cms-spec's canonicalizeLocaleList.`,
    );
    this.name = "InvalidSiteDefaultsError";
  }
}

export interface MediaPurposeIssue {
  readonly name: string;
  readonly reason:
    | "invalid-slug"
    | "empty-required"
    | "empty-required-slot"
    | "overlapping-slot-mimes"
    | "maxBytes-missing-mime"
    | "maxBytes-non-positive";
  readonly detail?: string;
}

export class InvalidMediaPurposesError extends Error {
  constructor(public readonly issues: ReadonlyArray<MediaPurposeIssue>) {
    super(
      `Invalid media purpose declaration(s) in CmsConfig.siteDefaults.media.purposes: ` +
        issues
          .map((i) => {
            const tag = `'${i.name || "(unnamed)"}'`;
            switch (i.reason) {
              case "invalid-slug":
                return `${tag} fails slug pattern ${MEDIA_PURPOSE_SLUG_PATTERN.source}`;
              case "empty-required":
                return `${tag} declares no required slots (need at least one)`;
              case "empty-required-slot":
                return `${tag} has a required slot that parses to zero mimes: ${i.detail}`;
              case "overlapping-slot-mimes":
                return `${tag} has slots with overlapping mime sets (variant→slot mapping is ambiguous): ${i.detail}`;
              case "maxBytes-missing-mime":
                return `${tag} maxBytes is missing entries: ${i.detail}`;
              case "maxBytes-non-positive":
                return `${tag} maxBytes has non-positive entries: ${i.detail}`;
            }
          })
          .join("; ") +
        `. Each purpose's name must match ` +
        `${MEDIA_PURPOSE_SLUG_PATTERN.source} (lowercase alphanumerics, ` +
        `dash-separated, no leading/trailing or repeated dashes); ` +
        `required mimes are the closed set the variants manifest must ` +
        `cover; maxBytes caps each variant's declared byteSize and MUST ` +
        `name every mime in required. See aotter/mantle#272.`,
    );
    this.name = "InvalidMediaPurposesError";
  }
}

export class InvalidSiteIconsError extends Error {
  constructor(public readonly invalidIcons: ReadonlyArray<SiteIcon>) {
    super(
      "Invalid CmsConfig.siteDefaults.icons: each icon needs a root-relative or absolute HTTPS src, " +
        "an optional supported image mimeType, and sizes such as '64x64' or 'any'.",
    );
    this.name = "InvalidSiteIconsError";
  }
}

export function assertSiteDefaultsCanonical(
  defaults: SiteDefaults | undefined,
): void {
  if (defaults?.locales && defaults.locales.length > 0) {
    const { invalid } = canonicalizeLocaleList(defaults.locales);
    if (invalid.length > 0) throw new InvalidSiteDefaultsError(invalid);
  }
  if (defaults?.icons) {
    const invalid = defaults.icons.filter((icon) => !validSiteIcon(icon));
    if (defaults.icons.length === 0 || invalid.length > 0) {
      throw new InvalidSiteIconsError(invalid.length > 0 ? invalid : defaults.icons);
    }
  }
  const purposes = defaults?.media?.purposes;
  if (purposes && purposes.length > 0) {
    const issues = collectMediaPurposeIssues(purposes);
    if (issues.length > 0) throw new InvalidMediaPurposesError(issues);
  }
}

function validSiteIcon(icon: SiteIcon): boolean {
  if (!icon || typeof icon !== "object" || typeof icon.src !== "string") return false;
  const validSrc = (/^\/(?!\/)[^\s\\]*$/.test(icon.src))
    || (URL.canParse(icon.src) && new URL(icon.src).protocol === "https:");
  return Boolean(
    validSrc
      && (!icon.mimeType || ["image/png", "image/jpeg", "image/svg+xml", "image/webp"].includes(icon.mimeType))
      && (!icon.theme || icon.theme === "light" || icon.theme === "dark")
      && (!icon.sizes || (Array.isArray(icon.sizes) && icon.sizes.length > 0))
      && (icon.sizes?.every((size) => typeof size === "string" && (size === "any" || /^[1-9]\d*x[1-9]\d*$/.test(size))) ?? true),
  );
}

function collectMediaPurposeIssues(
  purposes: ReadonlyArray<MediaPurposePolicy>,
): ReadonlyArray<MediaPurposeIssue> {
  const out: MediaPurposeIssue[] = [];
  for (const p of purposes) {
    if (!MEDIA_PURPOSE_SLUG_PATTERN.test(p.name)) {
      out.push({ name: p.name, reason: "invalid-slug" });
      continue;
    }
    if (p.required.length === 0) {
      out.push({ name: p.name, reason: "empty-required" });
      continue;
    }
    // Parse every slot under the `<input accept>` grammar (see
    // MediaMimeAccept). Each slot must yield ≥1 mime; otherwise
    // the agent has no acceptable mime to ship for that slot.
    const slots = expandPolicyRequired(p.required);
    const emptySlots = slots
      .map((mimes, i) => ({ mimes, raw: p.required[i] }))
      .filter((s) => s.mimes.length === 0);
    if (emptySlots.length > 0) {
      out.push({
        name: p.name,
        reason: "empty-required-slot",
        detail: emptySlots.map((s) => `'${s.raw}'`).join(", "),
      });
      continue;
    }
    // Variant → slot mapping is by mime: each supplied mime must
    // appear in exactly one slot, so the mime alone determines which
    // slot a variant fills. (Variant role — primary / alternate — is
    // declared independently by the agent and is NOT bound to slot
    // position; see MediaMimeAccept.ts file header.) Overlapping mime
    // sets break the by-mime mapping — reject at policy time rather
    // than fail per-upload.
    const seen = new Map<string, number>();
    const overlaps: string[] = [];
    slots.forEach((mimes, slotIdx) => {
      for (const mime of mimes) {
        if (seen.has(mime)) {
          overlaps.push(
            `'${mime}' in slots [${seen.get(mime)}, ${slotIdx}]`,
          );
        } else {
          seen.set(mime, slotIdx);
        }
      }
    });
    if (overlaps.length > 0) {
      out.push({
        name: p.name,
        reason: "overlapping-slot-mimes",
        detail: overlaps.join(", "),
      });
      continue;
    }
    // maxBytes must cover every mime that COULD be shipped — the
    // expanded set, not the literal `required[i]` strings.
    const expandedMimes = Array.from(seen.keys());
    const missing = expandedMimes.filter((mime) => !(mime in p.maxBytes));
    if (missing.length > 0) {
      out.push({
        name: p.name,
        reason: "maxBytes-missing-mime",
        detail: missing.join(", "),
      });
      continue;
    }
    const nonPositive = expandedMimes.filter(
      (mime) => !(typeof p.maxBytes[mime] === "number" && p.maxBytes[mime]! > 0),
    );
    if (nonPositive.length > 0) {
      out.push({
        name: p.name,
        reason: "maxBytes-non-positive",
        detail: nonPositive.map((m) => `${m}=${p.maxBytes[m]}`).join(", "),
      });
    }
  }
  return out;
}

// Re-export the accept-grammar parser at the validator level so
// runtime consumers (CreateMediaUploadUseCase, MCP tool catalog)
// can pull both validator + parser from one barrel.
export { parseMimeAccept };
