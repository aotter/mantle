import { describe, expect, it } from "vitest";
import type { PublishOrchestrator } from "../src/domain/port/PublishOrchestrator.js";
import type { SiteConfigRepository } from "../src/domain/port/SiteConfigRepository.js";
import { UpdateSiteSettingsUseCase } from "../src/usecase/site/index.js";

describe("UpdateSiteSettingsUseCase", () => {
  it("does not report success until derivative artifacts are invalidated", async () => {
    const calls: string[] = [];
    const siteConfig = {
      updateEditable: async () => { calls.push("update"); },
      load: async () => {
        calls.push("load");
        return {
          title: "Updated",
          description: "",
          origin: "",
          locales: ["en"],
          canonicalLocale: "en",
          brand: "Updated",
          media: { purposes: [] },
        };
      },
    } as unknown as SiteConfigRepository;
    const artifacts = {
      invalidateAll: async () => { calls.push("invalidate"); },
    } as unknown as PublishOrchestrator;

    const result = await new UpdateSiteSettingsUseCase(siteConfig, artifacts)
      .execute({ title: "Updated" });

    expect(result.title).toBe("Updated");
    expect(calls).toEqual(["update", "invalidate", "load"]);
  });
});
