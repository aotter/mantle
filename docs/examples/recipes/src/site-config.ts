import type { SiteDefaults } from "@aotter/mantle/site";

/** The site's languages. The first is the default: its text is in `recipes`; the others are `recipe_translations`. */
export const LOCALES = ["zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = LOCALES[0];

/**
 * Site defaults for `mantle generate ... --site src/site-config.ts`, which adds the media library tables and
 * `generated/site.ts`. The shell does not pass `--site`; see README "Cover images" for the two lines to add.
 */
export const siteDefaults = {
  title: "Recipes",
  description: "Home recipes in Traditional Chinese and English.",
  locales: [...LOCALES],
  media: { purposes: [{ name: "cover", required: ["image/jpeg,image/png,image/webp"], maxBytes: { "image/jpeg": 5_000_000, "image/png": 5_000_000, "image/webp": 5_000_000 } }] },
} satisfies SiteDefaults;
