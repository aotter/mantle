import type { SiteConfig } from "@aotter/mantle-spec";
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
    await this.siteConfig.updateEditable(request);
    if (this.onPublicChange) {
      try {
        await this.onPublicChange();
      } catch (error) {
        console.error("[mantle] public cache invalidation failed after committed site settings write", error);
      }
    }
    return this.siteConfig.load();
  }
}
