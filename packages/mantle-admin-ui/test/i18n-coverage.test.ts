import { describe, expect, it } from "vitest";

import { STRINGS } from "../src/app/i18n";
import { ADMIN_LANGUAGES } from "../src/app/preferences";

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
  "oauth.connectedApps",
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
  || key.startsWith("model.")
  || key.startsWith("logic.")
  || key.startsWith("docs.")
  || key.startsWith("developer.graph."),
);

describe("Required Admin translations", () => {
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
