import * as React from "react";

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
export type AdminDirection = "ltr" | "rtl";
export type AdminTheme = "light" | "dark" | "system";

const LANGUAGE_STORAGE_KEY = "cms.preference.language";
export const THEME_STORAGE_KEY = "cms.preference.theme";

interface PreferencesContextValue {
  language: AdminLanguage;
  direction: AdminDirection;
  theme: AdminTheme;
  setLanguage: (language: AdminLanguage) => void;
  setTheme: (theme: AdminTheme) => void;
}

const PreferencesContext = React.createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [language, setLanguageState] = React.useState<AdminLanguage>(readInitialLanguage);
  const direction = directionForLanguage(language);
  const [theme, setThemeState] = React.useState<AdminTheme>(readInitialTheme);

  const setLanguage = React.useCallback((next: AdminLanguage) => {
    writeStorage(LANGUAGE_STORAGE_KEY, next);
    setLanguageState(next);
  }, []);

  const setTheme = React.useCallback((next: AdminTheme) => {
    writeStorage(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  React.useEffect(() => {
    document.documentElement.lang =
      ADMIN_LANGUAGES.find((l) => l.value === language)?.htmlLang ?? "en";
    document.documentElement.dir = direction;
  }, [language, direction]);

  React.useEffect(() => {
    const applyTheme = () => {
      const systemDark =
        typeof matchMedia !== "undefined" &&
        matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && systemDark),
      );
    };
    applyTheme();
    if (theme !== "system" || typeof matchMedia === "undefined") return;
    const mql = matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", applyTheme);
    return () => mql.removeEventListener("change", applyTheme);
  }, [theme]);

  const value = React.useMemo<PreferencesContextValue>(
    () => ({
      language,
      direction,
      theme,
      setLanguage,
      setTheme,
    }),
    [language, direction, theme, setLanguage, setTheme],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const ctx = React.useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider.");
  return ctx;
}

function readInitialLanguage(): AdminLanguage {
  const stored = readStorage(LANGUAGE_STORAGE_KEY);
  if (isAdminLanguage(stored)) return stored;
  if (typeof navigator === "undefined") return "en";
  for (const nav of navigator.languages ?? []) {
    const normalized = normalizeLanguage(nav);
    if (normalized !== "en" || nav.toLowerCase().startsWith("en")) return normalized;
  }
  return normalizeLanguage(navigator.language);
}

function readInitialTheme(): AdminTheme {
  const stored = readStorage(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore: private mode / disabled storage */
  }
}

function isAdminLanguage(value: string | null): value is AdminLanguage {
  return ADMIN_LANGUAGES.some((l) => l.value === value);
}

export function normalizeLanguage(value: string | null | undefined): AdminLanguage {
  const lower = (value ?? "").toLowerCase();
  if (lower === "zh-tw" || lower === "zh-hant" || lower.startsWith("zh-hant")) return "zh-TW";
  if (lower === "zh-cn" || lower === "zh-hans" || lower.startsWith("zh-hans")) return "zh-CN";
  if (lower.startsWith("pt-br") || lower === "pt") return "pt-BR";
  const base = lower.split("-")[0];
  if (base === "ar") return "ar";
  if (base === "cs") return "cs";
  if (base === "de") return "de";
  if (base === "es") return "es";
  if (base === "fa") return "fa";
  if (base === "fr") return "fr";
  if (base === "he" || base === "iw") return "he";
  if (base === "id") return "id";
  if (base === "it") return "it";
  if (base === "ja") return "ja";
  if (base === "ko") return "ko";
  if (base === "nl") return "nl";
  if (base === "pl") return "pl";
  if (base === "pt") return "pt-BR";
  if (base === "ru") return "ru";
  if (base === "th") return "th";
  if (base === "tr") return "tr";
  if (base === "uk") return "uk";
  if (base === "vi") return "vi";
  if (base === "zh") return "zh-TW";
  return "en";
}

export function directionForLanguage(language: AdminLanguage): AdminDirection {
  return ADMIN_LANGUAGES.find((l) => l.value === language)?.direction ?? "ltr";
}
