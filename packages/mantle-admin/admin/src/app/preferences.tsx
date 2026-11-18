import * as React from "react";
import { loadLanguage } from "./i18n";

import { ADMIN_LANGUAGES, normalizeLanguage, type AdminLanguage } from "./languages";

export { ADMIN_LANGUAGES, normalizeLanguage, type AdminLanguage } from "./languages";
export type AdminDirection = "ltr" | "rtl";
export type AdminTheme = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<AdminTheme, "system">;

const LANGUAGE_STORAGE_KEY = "cms.preference.language";
export const THEME_STORAGE_KEY = "cms.preference.theme";

interface PreferencesContextValue {
  language: AdminLanguage;
  direction: AdminDirection;
  theme: AdminTheme;
  resolvedTheme: ResolvedTheme;
  setLanguage: (language: AdminLanguage) => void;
  setTheme: (theme: AdminTheme) => void;
}

const PreferencesContext = React.createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({
  children,
  initialLanguage,
}: React.PropsWithChildren<{ initialLanguage: AdminLanguage }>): React.ReactElement {
  const [language, setLanguageState] = React.useState(initialLanguage);
  const direction = directionForLanguage(language);
  const [theme, setThemeState] = React.useState<AdminTheme>(readInitialTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() =>
    resolveTheme(theme, systemPrefersDark()),
  );

  const languageRequest = React.useRef(0);
  const setLanguage = React.useCallback((next: AdminLanguage) => {
    const request = ++languageRequest.current;
    void loadLanguage(next)
      .then(() => {
        if (request !== languageRequest.current) return;
        writeStorage(LANGUAGE_STORAGE_KEY, next);
        setLanguageState(next);
      })
      .catch(error => console.error("Admin language could not be loaded", error));
  }, []);

  const setTheme = React.useCallback((next: AdminTheme) => {
    writeStorage(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  // Embedded hosts may supply a theme without changing the user's saved Admin preference.
  React.useEffect(() => {
    const syncHostTheme = () => setThemeState(readInitialTheme());
    const observer = new MutationObserver(syncHostTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mantle-theme"] });
    syncHostTheme();
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = ADMIN_LANGUAGES.find(l => l.value === language)?.htmlLang ?? "en";
    document.documentElement.dir = direction;
  }, [language, direction]);

  React.useEffect(() => {
    const applyTheme = () => {
      const resolved = resolveTheme(theme, systemPrefersDark());
      setResolvedTheme(resolved);
      markTheme(document.documentElement, resolved);
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
      resolvedTheme,
      setLanguage,
      setTheme,
    }),
    [language, direction, theme, resolvedTheme, setLanguage, setTheme],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const ctx = React.useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider.");
  return ctx;
}

export function readInitialLanguage(): AdminLanguage {
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
  const hostTheme =
    typeof document === "undefined" ? undefined : document.documentElement.getAttribute("data-mantle-theme");
  if (hostTheme === "light" || hostTheme === "dark") return hostTheme;
  const stored = readStorage(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** `.dark` and `data-theme` mark the same theme, as in an MCP host. */
export function markTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
}

export function resolveTheme(theme: AdminTheme, systemDark: boolean): ResolvedTheme {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
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
  return ADMIN_LANGUAGES.some(l => l.value === value);
}

export function directionForLanguage(language: AdminLanguage): AdminDirection {
  return ADMIN_LANGUAGES.find(l => l.value === language)?.direction ?? "ltr";
}
