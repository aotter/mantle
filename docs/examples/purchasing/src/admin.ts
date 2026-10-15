import type { AdminExtension, AdminNavGroup } from "@aotter/mantle-admin/server/extensions";

/**
 * Admin presentation, read by `mantle generate --admin-extensions src/admin.ts` (no runtime code).
 * The approver's daily work gets its own sidebar group above Admin's built-in ones (content 10, operations 20,
 * reports 30; More stays last); manifests place `pending-requests` and `requests` in it with `uiSchema.nav`.
 * AGENT: add groups for how the staff work; titles take one string or a { locale: text } map.
 */
export const navGroups: AdminNavGroup[] = [
  { id: "approvals", title: { en: "Approvals", "zh-TW": "簽核" }, order: 5 },
];
export const adminExtensions: AdminExtension[] = [];
