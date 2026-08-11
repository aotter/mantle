import { describe, expect, it } from "vitest";
import type { SiteConfigRepository } from "../src/domain/port/SiteConfigRepository.js";
import { UpdateSiteSettingsUseCase } from "../src/usecase/site/index.js";

describe("UpdateSiteSettingsUseCase", () => {
  it("persists and returns the current settings", async () => {
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
    const result = await new UpdateSiteSettingsUseCase(siteConfig)
      .execute({ title: "Updated" });

    expect(result.title).toBe("Updated");
    expect(calls).toEqual(["update", "load"]);
  });
});
