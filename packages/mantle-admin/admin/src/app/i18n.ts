import type { AdminLanguage } from "./preferences";
import english from "./locales/en";

export type I18nKey = keyof typeof english;
type Messages = Partial<Record<I18nKey, string>>;
/** English is eager; retained locales load before first paint or switching. */
export const STRINGS: Partial<Record<AdminLanguage, Messages>> & { en: typeof english } = { en: english };
const loaders = {
  "zh-TW": () => import("./locales/zh-TW"),
  "zh-CN": () => import("./locales/zh-CN"),
  "de": () => import("./locales/de"),
  "es": () => import("./locales/es"),
  "fr": () => import("./locales/fr"),
  "it": () => import("./locales/it"),
  "ja": () => import("./locales/ja"),
  "ko": () => import("./locales/ko"),
  "pt-BR": () => import("./locales/pt-BR"),
  "ru": () => import("./locales/ru"),
  "nl": () => import("./locales/nl"),
  "pl": () => import("./locales/pl"),
  "tr": () => import("./locales/tr"),
  "vi": () => import("./locales/vi"),
  "cs": () => import("./locales/cs"),
  "uk": () => import("./locales/uk"),
  "ar": () => import("./locales/ar"),
  "he": () => import("./locales/he"),
  "fa": () => import("./locales/fa"),
  "th": () => import("./locales/th"),
  "id": () => import("./locales/id"),
};
const pending = new Map<AdminLanguage, Promise<void>>();

export function loadLanguage(language: AdminLanguage): Promise<void> {
  if (language === "en" || STRINGS[language]) return Promise.resolve();
  const existing = pending.get(language);
  if (existing) return existing;
  const loading = loaders[language]().then(({ default: messages }) => {
    STRINGS[language] = messages;
  }).finally(() => pending.delete(language));
  pending.set(language, loading);
  return loading;
}

export function t(language: AdminLanguage, key: I18nKey, vars: Record<string, string> = {}): string {
  let out = STRINGS[language]?.[key] ?? english[key];
  for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(value);
  return out;
}
