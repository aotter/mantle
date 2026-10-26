import { beforeAll, describe, expect, it } from "vitest";

import { STRINGS, t, loadLanguage } from "../src/app/i18n";
import { ADMIN_LANGUAGES } from "../src/app/preferences";

beforeAll(() => Promise.all(ADMIN_LANGUAGES.map(({ value }) => loadLanguage(value))));

const REQUIRED_TRANSLATED_KEYS = new Set([
  "admin.consoleTitle",
  "developer.workspaceTitle",
  "common.breadcrumb",
  "common.close",
  "common.reloadPage",
  "common.reloadPageHint",
  "entryEdit.leaveUnsaved",
  "common.contentAdmin",
  "common.mobileSidebar",
  "common.mobileSidebarDescription",
  "common.skipToMain",
  "common.toggleSidebar",
  "common.yes",
  "common.no",
  "ops.details",
  "ops.conditionConflict",
  "ops.uniqueConflict",
  "nav.build",
  "nav.docs",
  "nav.localizedContent",
  "nav.logic",
  "nav.media",
  "nav.members",
  "nav.model",
  "nav.operations",
  "nav.overview",
  "nav.reports",
  "nav.admin",
]);

const translatedKeys = Object.keys(STRINGS.en).filter((key) =>
  REQUIRED_TRANSLATED_KEYS.has(key)
  || key.startsWith("oauth.")
  || key.startsWith("model.")
  || key.startsWith("logic.")
  || key.startsWith("docs.")
  || key.startsWith("developer.graph."),
);

describe("Required Admin translations", () => {
  it("describes the admin layer in every retained audience translation", () => {
    for (const {value} of ADMIN_LANGUAGES) expect(t(value, "developer.graph.audienceDescription.admin")).toMatch(/admin|amministr|管理|관리|مسؤول|مدیر|מנהל|beheerder|ผู้ดูแล|yönetici|адміністратор|администратор|quản trị/i);
    expect(t("zh-CN", "admin.role.admin")).toBe("管理员");
    expect(t("zh-CN", "admin.role.admin.help")).toContain("团队权限");
    expect(t("en", "admin.page.body")).not.toContain("Only site owners");
  });

  it("every declared language has the required messages and matching placeholders", () => {
    for (const { value } of ADMIN_LANGUAGES) {
      const messages = STRINGS[value] as Record<string, string>;
      expect(translatedKeys.filter((key) => !(key in messages))).toEqual([]);
      for (const key of translatedKeys) {
        expect(placeholders(messages[key])).toEqual(placeholders(STRINGS.en[key as keyof typeof STRINGS.en]));
      }
    }
  });
});

function placeholders(message: string): Array<string> {
  return message.match(/\{[^}]+\}/g)?.sort() ?? [];
}
