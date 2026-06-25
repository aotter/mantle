import { makeDiagnostic, type Diagnostic } from "@aotter/mantle-spec";

const PHASE = "runtime" as const;

export function mediaNotConfiguredDiagnostic(opPath: string): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_NOT_CONFIGURED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    expected: "media storage adapter bound at runtime",
    message:
      "Media uploads are not enabled on this deployment. Bind a `mediaStorage` adapter in `createCmsRuntime` to enable.",
  });
}

export function mediaMimeRejectedDiagnostic(opPath: string, mime: string): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_MIME_REJECTED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: mime,
    expected: "one of: image/png, image/jpeg, image/webp, image/avif, image/gif",
  });
}

export function mediaSvgRejectedDiagnostic(opPath: string): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_SVG_REJECTED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: "image/svg+xml",
    expected: "non-SVG image (object storage does not sanitize SVG payloads)",
    suggestion: "set MEDIA_ALLOW_SVG=1 on the adapter if SVG is required",
  });
}

export function mediaSizeExceededDiagnostic(
  opPath: string,
  byteSize: number,
  maxBytes: number,
): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_SIZE_EXCEEDED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: byteSize,
    expected: `byteSize <= ${maxBytes}`,
  });
}

export function mediaUploadExpiredDiagnostic(opPath: string, uploadGroupId: string): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_UPLOAD_EXPIRED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: uploadGroupId,
    expected: "an active upload capability (TTL elapsed or never created)",
    suggestion: "call create_media_upload again to get a fresh capability",
  });
}

export function mediaObjectNotFoundDiagnostic(opPath: string, uploadGroupId: string): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_OBJECT_NOT_FOUND",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: uploadGroupId,
    expected: "every variant object PUT to the storage backend before commit",
    suggestion: "PUT every variant's bytes to its uploadUrl before calling commit_media_upload",
  });
}

/** Caller supplied a `purpose` that this deployment did not declare in
 *  `siteDefaults.media.purposes`. Fail-closed per #262: alpha has no
 *  production consumers, so there is no warn-and-allow compatibility
 *  mode — undeclared purposes are always rejected. The `expected`
 *  field carries the declared set so agents can self-correct without
 *  another round trip. */
export function mediaPurposeRejectedDiagnostic(
  opPath: string,
  purpose: string | undefined,
  declared: readonly string[],
): Diagnostic {
  const expected =
    declared.length > 0
      ? `purpose ∈ {${declared.map((p) => `'${p}'`).join(", ")}}`
      : "media uploads are not enabled on this deployment (no `media.purposes` declared in siteDefaults)";
  return makeDiagnostic({
    code: "MEDIA_PURPOSE_REJECTED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: purpose ?? "(missing)",
    expected,
    suggestion:
      declared.length > 0
        ? "pass one of the declared purposes; starters own the taxonomy"
        : "add `media.purposes` to `siteDefaults` in mantleConfig.ts to enable uploads",
  });
}

/** Caller's variants manifest is missing one or more mimes the
 *  purpose policy declares as required. The expected field carries
 *  the declared required set + the supplied set so the agent script
 *  can self-correct without another round trip. */
export function mediaVariantsIncompleteDiagnostic(
  opPath: string,
  purpose: string,
  required: readonly string[],
  supplied: readonly string[],
): Diagnostic {
  const missing = required.filter((m) => !supplied.includes(m));
  return makeDiagnostic({
    code: "MEDIA_VARIANTS_INCOMPLETE",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: supplied,
    expected:
      `variants covering every required mime for purpose '${purpose}': ` +
      `${required.join(", ")}`,
    suggestion: `add the missing variant(s): ${missing.join(", ")}`,
  });
}

export function mediaVariantSizeExceededDiagnostic(
  opPath: string,
  mime: string,
  byteSize: number,
  maxBytes: number,
): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_VARIANT_SIZE_EXCEEDED",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: { mimeType: mime, byteSize },
    expected: `${mime} byteSize <= ${maxBytes}`,
    suggestion:
      "re-encode this variant with a smaller target size (sharp / libvips quality knob)",
  });
}

/**
 * Variant byte sizes don't match the format hierarchy the uploader
 * promised — typically avif > webp > jpeg (each modern format
 * smaller). When the upload manifest claims a modern format that's
 * larger than the universal-fallback (e.g. `avif` weighing more than
 * `jpeg`), the uploader almost certainly skipped optimization for
 * that variant. Fail hard rather than emit a `<picture>` that's
 * slower than the bare `<img>` fallback.
 */
export function mediaVariantsSuspiciousSizeDiagnostic(
  opPath: string,
  detail: string,
): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_VARIANTS_SUSPICIOUS_SIZE",
    phase: PHASE,
    severity: "error",
    path: opPath,
    expected:
      "modern formats no larger than their fallback (e.g. avif <= jpeg, webp <= jpeg)",
    value: detail,
    suggestion:
      "optimize this variant in the agent runtime before upload — the modern variant looks unprocessed",
  });
}

export function mediaAssetNotFoundDiagnostic(opPath: string, id: string): Diagnostic {
  return makeDiagnostic({
    code: "MEDIA_ASSET_NOT_FOUND",
    phase: PHASE,
    severity: "error",
    path: opPath,
    value: id,
    expected: "a row in media_assets matching this id",
    suggestion:
      "verify the asset id matches a successful commit_media_upload response, and that the asset hasn't been deleted",
  });
}
