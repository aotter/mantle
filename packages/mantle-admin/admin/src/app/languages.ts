export const ADMIN_LANGUAGES = [
  { value: "en", label: "English", nativeLabel: "English", htmlLang: "en", direction: "ltr" },
  { value: "de", label: "German", nativeLabel: "Deutsch", htmlLang: "de", direction: "ltr" },
  { value: "es", label: "Spanish", nativeLabel: "Español", htmlLang: "es", direction: "ltr" },
  { value: "fr", label: "French", nativeLabel: "Français", htmlLang: "fr", direction: "ltr" },
  { value: "it", label: "Italian", nativeLabel: "Italiano", htmlLang: "it", direction: "ltr" },
  { value: "ja", label: "Japanese", nativeLabel: "日本語", htmlLang: "ja", direction: "ltr" },
  { value: "ko", label: "Korean", nativeLabel: "한국어", htmlLang: "ko", direction: "ltr" },
  { value: "pt-BR", label: "Portuguese (Brazil)", nativeLabel: "Português (BR)", htmlLang: "pt-BR", direction: "ltr" },
  { value: "ru", label: "Russian", nativeLabel: "Русский", htmlLang: "ru", direction: "ltr" },
  { value: "zh-CN", label: "Simplified Chinese", nativeLabel: "简体中文", htmlLang: "zh-Hans-CN", direction: "ltr" },
  { value: "zh-TW", label: "Traditional Chinese", nativeLabel: "繁體中文", htmlLang: "zh-Hant-TW", direction: "ltr" },
  { value: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia", htmlLang: "id", direction: "ltr" },
  { value: "nl", label: "Dutch", nativeLabel: "Nederlands", htmlLang: "nl", direction: "ltr" },
  { value: "pl", label: "Polish", nativeLabel: "Polski", htmlLang: "pl", direction: "ltr" },
  { value: "tr", label: "Turkish", nativeLabel: "Türkçe", htmlLang: "tr", direction: "ltr" },
  { value: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt", htmlLang: "vi", direction: "ltr" },
  { value: "cs", label: "Czech", nativeLabel: "Čeština", htmlLang: "cs", direction: "ltr" },
  { value: "uk", label: "Ukrainian", nativeLabel: "Українська", htmlLang: "uk", direction: "ltr" },
  { value: "ar", label: "Arabic", nativeLabel: "العربية", htmlLang: "ar", direction: "rtl" },
  { value: "he", label: "Hebrew", nativeLabel: "עברית", htmlLang: "he", direction: "rtl" },
  { value: "fa", label: "Persian", nativeLabel: "فارسی", htmlLang: "fa", direction: "rtl" },
  { value: "th", label: "Thai", nativeLabel: "ไทย", htmlLang: "th", direction: "ltr" },
] as const;

export type AdminLanguage = (typeof ADMIN_LANGUAGES)[number]["value"];

/** Resolves a browser/host tag against the shared Admin language list. */
export function normalizeLanguage(value: string | null | undefined): AdminLanguage {
  const tag = (value ?? "").toLowerCase().replaceAll("_", "-");
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return "zh-TW";
  if (/^zh-(hans|cn|sg)(-|$)/.test(tag)) return "zh-CN";
  const base = tag.split("-")[0];
  if (base === "zh") return "zh-TW";
  if (base === "pt") return "pt-BR";
  if (base === "iw") return "he";
  return ADMIN_LANGUAGES.find(language => language.value === base)?.value ?? "en";
}
