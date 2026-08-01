import type { SiteConfig } from "@aotter/mantle-spec";
import type { PublishOrchestrator } from "../../domain/port/PublishOrchestrator.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import type { UpdateSiteSettingsRequest } from "../dto/site/index.js";

/** Persist editable settings and invalidate their derivative public artifacts. */
export class UpdateSiteSettingsUseCase {
  constructor(
    private readonly siteConfig: SiteConfigRepository,
    private readonly artifacts: PublishOrchestrator,
  ) {}

  async execute(request: UpdateSiteSettingsRequest): Promise<SiteConfig> {
    if (!this.siteConfig.updateEditable) {
      throw new Error("SiteConfigRepository.updateEditable is unavailable");
    }
    await this.siteConfig.updateEditable(request);
    await this.artifacts.invalidateAll();
    return this.siteConfig.load();
  }
}
