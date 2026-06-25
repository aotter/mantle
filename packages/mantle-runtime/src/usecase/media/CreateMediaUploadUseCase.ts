import {
  DiagnosticError,
  expandPolicyRequired,
  type MediaPurposePolicy,
} from "@aotter/mantle-spec";
import type { Clock } from "../../domain/port/Clock.js";
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { KvCache } from "../../domain/port/KvCache.js";
import type {
  CreateUploadVariantSpec,
  MediaStorage,
} from "../../domain/port/MediaStorage.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import type {
  CreateMediaUploadRequest,
  CreateMediaUploadResponse,
  CreateMediaUploadVariantRequest,
} from "../dto/media/index.js";
import {
  mediaMimeRejectedDiagnostic,
  mediaPurposeRejectedDiagnostic,
  mediaSvgRejectedDiagnostic,
  mediaVariantSizeExceededDiagnostic,
  mediaVariantsIncompleteDiagnostic,
  mediaVariantsSuspiciousSizeDiagnostic,
} from "./diagnostics.js";
import {
  MEDIA_SVG_MIME,
  PENDING_UPLOAD_KV_PREFIX,
  PENDING_UPLOAD_KV_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  isAllowedMime,
} from "./mediaAllowlist.js";
import type {
  PendingUploadRecord,
  PendingUploadVariant,
} from "./PendingUploadRecord.js";

/**
 * Issue presigned upload capabilities for every variant the agent
 * declares for one logical media asset (#272). The asset's `id` is
 * minted here and surfaces as `uploadGroupId` in the response — the
 * caller passes it back to `commit_media_upload`.
 *
 * Optimization runs agent-side in the MCP client's runtime. This
 * use case enforces policy only — never transforms bytes:
 *  - purpose must be declared in `siteDefaults.media.purposes`
 *  - variants must cover every required mime for that purpose
 *  - each variant's byteSize ≤ `policy.maxBytes[mime]`
 *  - mime allowlist (still gates per variant; SVG opt-in via ctor)
 *  - "suspicious shape" heuristic: modern formats (avif / webp) MUST
 *    NOT be larger than the fallback (jpeg) — uploader skipped
 *    optimization → hard fail rather than emit a `<picture>` slower
 *    than the bare `<img>`.
 */
export class CreateMediaUploadUseCase {
  constructor(
    private readonly storage: MediaStorage,
    private readonly kv: KvCache,
    private readonly clock: Clock,
    private readonly idgen: IdGenerator,
    private readonly siteConfig: SiteConfigRepository,
    private readonly opts: { readonly allowSvg: boolean } = { allowSvg: false },
  ) {}

  async execute(request: CreateMediaUploadRequest): Promise<CreateMediaUploadResponse> {
    const opPath = "usecase/CreateMediaUpload";

    const declared = await this.siteConfig.readMediaPurposes();
    const declaredNames = declared.map((p) => p.name);
    const policy = declared.find((p) => p.name === request.purpose);
    if (!policy) {
      throw new DiagnosticError(
        mediaPurposeRejectedDiagnostic(opPath, request.purpose, declaredNames),
      );
    }

    this.assertVariantsCoverPolicy(opPath, request, policy);
    this.assertEachVariantAccepted(opPath, request);
    this.assertVariantSizesUnderCap(opPath, request, policy);
    this.assertNoSuspiciousSizing(opPath, request);

    const now = this.clock.now();
    const expiresAt = now + UPLOAD_URL_TTL_SECONDS * 1000;
    const uploadGroupId = this.idgen.next();

    const variantSpecs: ReadonlyArray<CreateUploadVariantSpec> = request.variants.map((v) => ({
      mimeType: v.mimeType,
      byteSize: v.byteSize,
      maxBytes: policy.maxBytes[v.mimeType] ?? Number.MAX_SAFE_INTEGER,
      role: v.role,
    }));

    const result = await this.storage.createUpload({
      uploadGroupId,
      purpose: request.purpose,
      filename: request.filename,
      variants: variantSpecs,
      now,
      expiresAt,
    });

    const pendingVariants: PendingUploadVariant[] = result.capabilities.map((cap, i) => ({
      mimeType: cap.mimeType,
      role: cap.role,
      storageKey: cap.storageKey,
      expectedSize: variantSpecs[i]!.byteSize,
      maxBytes: variantSpecs[i]!.maxBytes,
    }));

    const record: PendingUploadRecord = {
      purpose: request.purpose,
      filename: request.filename,
      variants: pendingVariants,
      alt: request.alt,
      caption: request.caption,
      expiresAt: result.expiresAt,
      createdAt: now,
    };

    await this.kv.put(
      `${PENDING_UPLOAD_KV_PREFIX}${result.uploadGroupId}`,
      JSON.stringify(record),
      { expirationTtl: PENDING_UPLOAD_KV_TTL_SECONDS },
    );

    return {
      uploadGroupId: result.uploadGroupId,
      capabilities: result.capabilities.map((cap) => ({
        mimeType: cap.mimeType,
        role: cap.role,
        method: cap.method,
        uploadUrl: cap.uploadUrl,
        requiredHeaders: cap.requiredHeaders,
      })),
      expiresAt: result.expiresAt,
    };
  }

  private assertVariantsCoverPolicy(
    opPath: string,
    request: CreateMediaUploadRequest,
    policy: MediaPurposePolicy,
  ): void {
    // Expand the `<input accept>`-style grammar (#282) into per-slot
    // acceptable mime sets. The policy validator already rejected
    // overlapping mime sets across slots + empty slots, so variant→slot
    // mapping here is unambiguous: each supplied mime appears in
    // exactly one slot. Role (primary vs alternate) stays free per
    // variant — the agent picks which mime is primary, constrained
    // only by the exactly-one-primary rule below.
    const slots = expandPolicyRequired(policy.required);
    const expandedSet = new Set<string>();
    const mimeToSlot = new Map<string, number>();
    slots.forEach((mimes, slotIdx) => {
      for (const m of mimes) {
        expandedSet.add(m);
        mimeToSlot.set(m, slotIdx);
      }
    });
    const supplied = request.variants.map((v) => v.mimeType);

    // Closed set: any supplied mime outside the expanded acceptable
    // set has no maxBytes coverage and no slot assignment. Reject.
    const extras = request.variants.filter((v) => !expandedSet.has(v.mimeType));
    if (extras.length > 0) {
      throw new DiagnosticError(
        mediaVariantsIncompleteDiagnostic(
          opPath, policy.name, policy.required, supplied,
        ),
      );
    }

    // Exactly one variant per slot — covers "missing slot" and
    // "two variants for the same slot" (e.g. an extra `image/jpeg`
    // when slot 0 = `image/jpg,image/png`: both jpg and png supplied
    // would fill slot 0 twice and leave the png slot unfilled if you
    // count by mime-set).
    const filledSlots = new Set<number>();
    for (const v of request.variants) {
      const slotIdx = mimeToSlot.get(v.mimeType)!; // safe: extras rejected above
      if (filledSlots.has(slotIdx)) {
        throw new DiagnosticError(
          mediaVariantsIncompleteDiagnostic(
            opPath, policy.name, policy.required, supplied,
          ),
        );
      }
      filledSlots.add(slotIdx);
    }
    if (filledSlots.size !== slots.length) {
      throw new DiagnosticError(
        mediaVariantsIncompleteDiagnostic(
          opPath, policy.name, policy.required, supplied,
        ),
      );
    }

    // Exactly one primary. Storage key layout is `<group>/<role>.<ext>`,
    // so two primaries collide on the same R2 key + ambiguate which
    // variant `<img>` falls back to. Two alternates with different
    // mimes don't collide (different ext); two alternates with the
    // same mime are impossible here because the mime-to-slot mapping
    // would have caught the duplicate above.
    const primaries = request.variants.filter((v) => v.role === "primary");
    if (primaries.length !== 1) {
      throw new DiagnosticError(
        mediaVariantsIncompleteDiagnostic(
          opPath, policy.name, policy.required, supplied,
        ),
      );
    }
  }

  /** Enforce per-mime byte caps from the purpose policy BEFORE the
   *  adapter signs presigned PUT URLs. Mantle docs / ADR-0017
   *  promise this gate at create time — without it, oversized
   *  variants only fail after R2 has accepted the bytes (wasted
   *  upload + potential bill).
   *
   *  Also gates on positive-integer byteSize. JSON-RPC and HTTP
   *  validation only narrow to `typeof === "number"`, so 0, -1, or
   *  0.5 can reach here and produce signed URLs against a maxBytes
   *  comparison that accepts them. */
  private assertVariantSizesUnderCap(
    opPath: string,
    request: CreateMediaUploadRequest,
    policy: MediaPurposePolicy,
  ): void {
    for (const v of request.variants) {
      if (!Number.isSafeInteger(v.byteSize) || v.byteSize <= 0) {
        throw new DiagnosticError(
          mediaVariantSizeExceededDiagnostic(opPath, v.mimeType, v.byteSize, 0),
        );
      }
      const cap = policy.maxBytes[v.mimeType];
      // mime outside policy.required was already rejected in
      // assertVariantsCoverPolicy; defensive check so a future
      // refactor doesn't silently uncap.
      if (cap === undefined) {
        throw new DiagnosticError(
          mediaVariantSizeExceededDiagnostic(opPath, v.mimeType, v.byteSize, 0),
        );
      }
      if (v.byteSize > cap) {
        throw new DiagnosticError(
          mediaVariantSizeExceededDiagnostic(opPath, v.mimeType, v.byteSize, cap),
        );
      }
    }
  }

  private assertEachVariantAccepted(
    opPath: string,
    request: CreateMediaUploadRequest,
  ): void {
    for (const v of request.variants) {
      if (v.mimeType === MEDIA_SVG_MIME && !this.opts.allowSvg) {
        throw new DiagnosticError(mediaSvgRejectedDiagnostic(opPath));
      }
      if (!isAllowedMime(v.mimeType, this.opts.allowSvg)) {
        throw new DiagnosticError(mediaMimeRejectedDiagnostic(opPath, v.mimeType));
      }
    }
  }

  private assertNoSuspiciousSizing(
    opPath: string,
    request: CreateMediaUploadRequest,
  ): void {
    const fallback = pickFallbackForSizing(request.variants);
    if (!fallback) return;
    for (const v of request.variants) {
      if (v === fallback) continue;
      if (!MODERN_FORMATS.has(v.mimeType)) continue;
      if (v.byteSize > fallback.byteSize) {
        throw new DiagnosticError(
          mediaVariantsSuspiciousSizeDiagnostic(
            opPath,
            `${v.mimeType} (${v.byteSize}B) > ${fallback.mimeType} (${fallback.byteSize}B)`,
          ),
        );
      }
    }
  }
}

/** Modern formats that, by convention, should be smaller than the
 *  universal fallback (jpeg / png). Used by the "suspicious sizing"
 *  heuristic — if any of these weigh more than the fallback, the
 *  uploader almost certainly skipped optimization. */
const MODERN_FORMATS = new Set(["image/avif", "image/webp"]);

/** Pick the variant to compare modern formats against — preferred
 *  order: jpeg → png → gif. Returns undefined when none of the
 *  classic-format variants are present (e.g. an avif-only upload),
 *  in which case the heuristic skips. */
function pickFallbackForSizing(
  variants: readonly CreateMediaUploadVariantRequest[],
): CreateMediaUploadVariantRequest | undefined {
  for (const mime of ["image/jpeg", "image/png", "image/gif"]) {
    const found = variants.find((v) => v.mimeType === mime);
    if (found) return found;
  }
  return undefined;
}
