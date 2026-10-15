import type { AdminExtension, AdminNavGroup } from "@aotter/mantle-admin/server/extensions";

/**
 * Admin presentation, read by `mantle generate --admin-extensions src/admin.ts` (no runtime code).
 * AGENT: to group the sidebar for how staff work, declare groups here and place Schemas and admin Views in them with
 * `uiSchema.nav: { group, order, hidden }` (docs/handbook/guides/native-admin.md, "Sidebar"). Built-in groups need no
 * declaration: content, operations, reports, more. Admin extensions also go here.
 */
export const navGroups: AdminNavGroup[] = [];
export const adminExtensions: AdminExtension[] = [];
