import { t } from "../app/i18n";
import type { AdminLanguage } from "../app/preferences";

export function renderTitleText(title: unknown, language: AdminLanguage): string {
  if (typeof title === "string" && title) return title;
  if (title == null || title === "") return t(language, "collection.untitled");
  return JSON.stringify(title);
}
