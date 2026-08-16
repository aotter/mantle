import { DiagnosticError, runtimeDiagnostic, type SiteConfig } from "@aotter/mantle-spec";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import type { UpdateSiteSettingsRequest } from "../dto/site/index.js";

/** Persist editable site settings. */
export class UpdateSiteSettingsUseCase {
  constructor(
    private readonly siteConfig: SiteConfigRepository,
    private readonly onPublicChange?: () => Promise<void>,
  ) {}

  async execute(request: UpdateSiteSettingsRequest): Promise<SiteConfig> {
    if (!this.siteConfig.updateEditable) {
      throw new Error("SiteConfigRepository.updateEditable is unavailable");
    }
    await this.siteConfig.updateEditable({
      ...request,
      ga4MeasurementId: normalizeOptionalId(
        request.ga4MeasurementId,
        normalizeGa4MeasurementId,
        "ga4MeasurementId",
        "a GA4 Measurement ID such as G-XXXXXXXXXX, or an empty string",
      ),
      facebookPixelId: normalizeOptionalId(
        request.facebookPixelId,
        normalizeFacebookPixelId,
        "facebookPixelId",
        "a numeric Facebook Pixel ID, or an empty string",
      ),
    });
    await this.onPublicChange?.();
    return this.siteConfig.load();
  }
}

function normalizeGa4MeasurementId(value: string | undefined): string | null {
  const trimmed = value?.trim().toUpperCase() ?? "";
  return /^G-[A-Z0-9]{4,32}$/.test(trimmed) ? trimmed : null;
}

function normalizeFacebookPixelId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^[0-9]{5,32}$/.test(trimmed) ? trimmed : null;
}

function normalizeOptionalId(
  value: string | undefined,
  normalize: (value: string | undefined) => string | null,
  field: string,
  expected: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) return "";
  const normalized = normalize(value);
  if (normalized) return normalized;
  throw new DiagnosticError(runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED",
    severity: "error",
    path: `usecase/UpdateSiteSettings/${field}`,
    value,
    expected,
    message: `Invalid ${field}.`,
  }));
}
