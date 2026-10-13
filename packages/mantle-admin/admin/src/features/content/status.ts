import type { SidebarStatus } from "../../lib/types";
import type { AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";

export function statusLabel(
  language: AdminLanguage,
  status: SidebarStatus,
): string {
  switch (status) {
    case "draft":
      return t(language, "status.draft");
    case "published":
      return t(language, "status.published");
    case "archived":
      return t(language, "status.archived");
  }
}
