import { beforeAll, describe, expect, it } from "vitest";

import { STRINGS, t, loadLanguage } from "../src/app/i18n";
import { ADMIN_LANGUAGES } from "../src/app/preferences";

beforeAll(() => Promise.all(ADMIN_LANGUAGES.map(({ value }) => loadLanguage(value))));

const REQUIRED_TRANSLATED_KEYS = new Set([
  "admin.consoleTitle",
  "developer.workspaceTitle",
  "common.breadcrumb",
  "common.close",
  "common.contentAdmin",
  "common.mobileSidebar",
  "common.mobileSidebarDescription",
  "common.skipToMain",
  "common.toggleSidebar",
  "common.yes",
  "common.no",
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
  "nav.staff",
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
  it("describes the one OSS staff role in every retained audience translation", () => {
    for (const {value} of ADMIN_LANGUAGES) expect(t(value, "developer.graph.audienceDescription.staff")).toContain("staff");
    expect(t("zh-CN", "staff.role.staff")).toBe("团队人员");
    expect(t("zh-CN", "staff.role.staff.help")).toContain("团队权限");
    expect(t("en", "staff.page.body")).not.toContain("Only site owners");
  });

  for (const { value } of ADMIN_LANGUAGES) {
    it(`has every required ${value} message`, () => {
      const messages = STRINGS[value] as Record<string, string>;
      expect(translatedKeys.filter((key) => !(key in messages))).toEqual([]);
      for (const key of translatedKeys) {
        expect(placeholders(messages[key])).toEqual(placeholders(STRINGS.en[key as keyof typeof STRINGS.en]));
      }
    });
  }
});

function placeholders(message: string): Array<string> {
  return message.match(/\{[^}]+\}/g)?.sort() ?? [];
}
