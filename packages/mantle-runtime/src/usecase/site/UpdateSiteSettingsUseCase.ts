import type { SiteConfig } from "@aotter/mantle-spec";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import type { UpdateSiteSettingsRequest } from "../dto/site/index.js";

/** Persist editable site settings. */
export class UpdateSiteSettingsUseCase {
  constructor(private readonly siteConfig: SiteConfigRepository) {}

  async execute(request: UpdateSiteSettingsRequest): Promise<SiteConfig> {
    if (!this.siteConfig.updateEditable) {
      throw new Error("SiteConfigRepository.updateEditable is unavailable");
    }
    await this.siteConfig.updateEditable(request);
    return this.siteConfig.load();
  }
}
