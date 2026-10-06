/** `site_config` rows to the config the runtime serves, for any engine (Admin reads the defaults with no rows). */
import { DEFAULT_SITE_ICONS, type MediaPurposePolicy, type SiteConfig, type SiteIcon } from "../spec/domain/index.js";

const parse = <T>(raw: string | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** The stored rows as the runtime reads them; no rows is every default. */
export function siteConfigOf(rows: readonly Record<string, unknown>[]): SiteConfig {
  const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  const locales = (m.get("locales") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const purposes = parse<unknown>(m.get("mediaPurposes"), []);
  const icons = m.get("faviconUrl");
  // 0.1 alphas stored one plain favicon URL
  const parsedIcons = parse<unknown>(icons, icons ? [{ src: icons }] : DEFAULT_SITE_ICONS);
  return {
    title: m.get("title") ?? "CMS", description: m.get("description") ?? "", origin: m.get("origin") ?? "",
    locales, canonicalLocale: locales[0] ?? null, brand: m.get("brand") ?? "AotterMantle",
    icons: Array.isArray(parsedIcons) && parsedIcons.length ? parsedIcons as SiteIcon[] : DEFAULT_SITE_ICONS,
    media: { purposes: Array.isArray(purposes) ? purposes as MediaPurposePolicy[] : [] },
  };
}
