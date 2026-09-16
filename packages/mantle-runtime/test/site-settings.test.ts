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

  it("returns committed settings when cache invalidation fails", async () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      const siteConfig = {
        updateEditable: async () => undefined,
        load: async () => ({
          title: "Saved",
          description: "",
          origin: "",
          locales: ["en"],
          canonicalLocale: "en",
          brand: "Saved",
          media: { purposes: [] },
        }),
      } as unknown as SiteConfigRepository;

      await expect(new UpdateSiteSettingsUseCase(
        siteConfig,
        async () => { throw new Error("purge unavailable"); },
      ).execute({ title: "Saved" })).resolves.toMatchObject({ title: "Saved" });
    } finally {
      console.error = error;
    }
  });
});
