import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { api } from "../../lib/api";
import type { CommittedMediaAsset, MediaPurposePolicy } from "../../lib/types";

type UploadCapability = {
  mimeType: string;
  role: "primary" | "alternate" | "fallback";
  method: "PUT";
  uploadUrl: string;
  requiredHeaders?: Record<string, string>;
};

type MediaUploadResponse = {
  uploadGroupId: string;
  capabilities: UploadCapability[];
};

type PreparedVariant = {
  mimeType: string;
  role: "primary" | "alternate" | "fallback";
  blob: Blob;
};

export async function uploadMediaAsset(args: {
  file: File;
  purposes: readonly MediaPurposePolicy[];
  preferredPurpose?: string;
  alt?: string;
  caption?: string;
  language?: AdminLanguage;
}): Promise<CommittedMediaAsset> {
  const purpose = selectPurpose(args.purposes, args.preferredPurpose);
  if (!purpose) {
    throw new Error("No media upload purpose is configured for this site.");
  }
  const variants = await prepareImageVariants(args.file, purpose, args.language ?? "en");
  const created = await api.post<MediaUploadResponse>("/media/uploads", {
    filename: args.file.name,
    purpose: purpose.name,
    variants: variants.map((variant) => ({
      mimeType: variant.mimeType,
      byteSize: variant.blob.size,
      role: variant.role,
    })),
    alt: args.alt ?? defaultAlt(args.file),
    caption: args.caption,
  });

  for (const variant of variants) {
    const capability = created.capabilities.find(
      (cap) => cap.mimeType === variant.mimeType && cap.role === variant.role,
    );
    if (!capability) {
      throw new Error(`Upload capability missing for ${variant.mimeType}.`);
    }
    await fetch(capability.uploadUrl, {
      method: capability.method,
      headers: capability.requiredHeaders ?? { "Content-Type": variant.mimeType },
      body: variant.blob,
    });
  }

  return api.post<CommittedMediaAsset>(
    `/media/uploads/${encodeURIComponent(created.uploadGroupId)}/commit`,
    {
      alt: args.alt ?? defaultAlt(args.file),
      caption: args.caption,
    },
  );
}

export function selectPurpose(
  purposes: readonly MediaPurposePolicy[],
  preferredPurpose?: string,
): MediaPurposePolicy | null {
  if (preferredPurpose) {
    const exact = purposes.find((purpose) => purpose.name === preferredPurpose);
    if (exact) return exact;
  }
  const content = purposes.find((purpose) => purpose.name === "content");
  return content ?? purposes[0] ?? null;
}

export function purposeForMediaField(
  purposes: readonly MediaPurposePolicy[],
  collectionName: string,
  path: readonly string[],
): string | undefined {
  const field = path[path.length - 1] ?? "";
  const base = singularize(collectionName.replace(/-translations$/, ""));
  const candidates: string[] = [];
  if (/cover/i.test(field)) candidates.push(`${base}-cover`);
  if (/image|asset|media/i.test(field)) {
    candidates.push(`${base}-image`);
    candidates.push(`${base}-media`);
  }
  candidates.push("content");
  for (const candidate of candidates) {
    if (purposes.some((purpose) => purpose.name === candidate)) return candidate;
  }
  return purposes[0]?.name;
}

export function primaryPublicUrl(asset: CommittedMediaAsset): string | null {
  const variant = asset.variants.find((item) => item.role === "primary") ?? asset.variants[0];
  return variant?.publicUrl ?? null;
}

async function prepareImageVariants(
  file: File,
  policy: MediaPurposePolicy,
  language: AdminLanguage,
): Promise<PreparedVariant[]> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("Only raster image uploads are supported in the admin UI.");
  }
  const slots = expandRequired(policy.required);
  if (slots.length === 0) {
    throw new Error(`Media purpose '${policy.name}' does not declare required image variants.`);
  }
  const bitmap = await createImageBitmap(file);
  try {
    const selected = await Promise.all(slots.map((slot) => chooseMime(slot, policy, language)));
    const primaryMime = selected.find(isClassicFallbackMime) ?? selected[0]!;
    const variants: PreparedVariant[] = [];
    for (const mimeType of selected) {
      const maxBytes = policy.maxBytes[mimeType] ?? Number.MAX_SAFE_INTEGER;
      variants.push({
        mimeType,
        role: mimeType === primaryMime ? "primary" : "alternate",
        blob: await encodeBitmap(bitmap, mimeType, maxBytes, language),
      });
    }
    return variants;
  } finally {
    bitmap.close?.();
  }
}

function expandRequired(required: readonly string[]): string[][] {
  return required
    .map((slot) => slot.split(",").map(normalizeMime).filter((mime): mime is string => Boolean(mime)))
    .filter((slot) => slot.length > 0);
}

function normalizeMime(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === "jpg" || value === "jpeg" || value === "image/jpg") return "image/jpeg";
  if (value === "png") return "image/png";
  if (value === "webp") return "image/webp";
  if (value === "avif") return "image/avif";
  if (value === "gif") return "image/gif";
  return value.includes("/") ? value : null;
}

// Per-mime canvas encoder capability, probed once and cached for the life
// of the module — `toBlob` is async, so there's no cheap synchronous way
// to know whether e.g. image/avif is actually supported before trying it.
// A mime is "encodable" iff a 1x1 canvas' `toBlob(mime)` returns a blob
// whose `type` echoes back the requested mime (unsupported encoders
// silently fall back to image/png instead of rejecting).
const encoderProbeCache = new Map<string, Promise<boolean>>();

function probeEncoderSupport(mimeType: string): Promise<boolean> {
  let probe = encoderProbeCache.get(mimeType);
  if (!probe) {
    probe = (async () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, mimeType),
        );
        return blob?.type === mimeType;
      } catch {
        // Non-browser / unavailable canvas: probing is impossible, so
        // fall back to the previous maxBytes-only behavior rather than
        // failing every upload in an environment we can't inspect.
        return true;
      }
    })();
    encoderProbeCache.set(mimeType, probe);
  }
  return probe;
}

export async function chooseMime(
  slot: readonly string[],
  policy: MediaPurposePolicy,
  language: AdminLanguage,
): Promise<string> {
  for (const mime of slot) {
    if (!mime.startsWith("image/")) continue;
    if (policy.maxBytes[mime] == null) continue;
    if (!(await probeEncoderSupport(mime))) continue;
    return mime;
  }
  const attempted = slot.find((mime) => mime.startsWith("image/") && policy.maxBytes[mime] != null);
  throw new Error(t(language, "media.encoderUnsupported", { mime: attempted ?? slot[0] ?? "?" }));
}

export async function encodeBitmap(
  bitmap: ImageBitmap,
  mimeType: string,
  maxBytes: number,
  language: AdminLanguage,
): Promise<Blob> {
  let scale = 1;
  const qualitySteps = mimeType === "image/jpeg"
    ? [0.88, 0.78, 0.68, 0.58]
    : [0.78, 0.68, 0.58, 0.48];
  let best: Blob | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const quality of qualitySteps) {
      const blob = await drawAndEncode(bitmap, mimeType, scale, quality);
      if (blob.type !== mimeType) {
        // First attempt came back as a different type than requested —
        // the encoder doesn't support this mime at all, so every further
        // scale/quality retry would fail the same way. Bail immediately
        // instead of burning 6 scales x 4 qualities on a lost cause (#440).
        if (attempt === 0 && best === null) {
          throw new Error(t(language, "media.encoderUnsupported", { mime: mimeType }));
        }
        continue;
      }
      best = blob;
      if (blob.size <= maxBytes) return blob;
    }
    scale *= 0.82;
  }
  if (best) return best;
  throw new Error(`This browser cannot encode ${mimeType}.`);
}

async function drawAndEncode(
  bitmap: ImageBitmap,
  mimeType: string,
  scale: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare image upload.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  if (!blob) throw new Error(`This browser cannot encode ${mimeType}.`);
  return blob;
}

function isClassicFallbackMime(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif";
}

function singularize(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses")) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}

function defaultAlt(file: File): string {
  return file.name.replace(/\.[^.]+$/, "");
}
