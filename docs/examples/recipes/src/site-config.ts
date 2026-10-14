import type { SiteDefaults } from "@aotter/mantle/site";

/**
 * Site defaults for `mantle generate ... --site src/site-config.ts`, which adds the media library tables and
 * `generated/site.ts`. The shell does not pass `--site`; see README "Cover images" for the two lines to add.
 */
export const siteDefaults = {
  title: "Recipes",
  description: "Home recipes in Traditional Chinese and English.",
  locales: ["zh-TW", "en"],
  media: { purposes: [{ name: "cover", required: ["image/jpeg,image/png,image/webp"], maxBytes: { "image/jpeg": 5_000_000, "image/png": 5_000_000, "image/webp": 5_000_000 } }] },
} satisfies SiteDefaults;
