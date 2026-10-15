/** Admin sidebar placement: `uiSchema.nav.{group, order, hidden}` and the project's `navGroups`. Presentation only. */
import { isLocalizedText, type LocalizedText } from "./ManifestGrammar.js";

/** Admin's own groups. Project groups sort among content 10, operations 20 and reports 30 by `order`; More always stays last. */
export const BUILT_IN_NAV_GROUPS: ReadonlySet<string> = new Set(["content", "operations", "reports", "more"]);
export interface AdminNavGroup { readonly id: string; readonly title: LocalizedText; readonly order?: number }
export const NAV_PLACEMENT_KEYS = ["group", "order", "hidden"] as const;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The problem with one placement key's value, or null. Group ids are checked against `navGroups` at generate. */
export function navPlacementProblem(key: string, value: unknown): string | null {
  if (key === "group") return typeof value === "string" && ID.test(value) ? null : "a kebab-case group id";
  if (key === "order") return Number.isInteger(value) ? null : "an integer";
  if (key === "hidden") return typeof value === "boolean" ? null : "a boolean";
  return null;
}

/** `navGroups` problems as [path, message]; ids must be kebab-case, unique and not a built-in group. */
export function navGroupProblems(groups: unknown): [string, string][] {
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) return [["admin/navGroups", "navGroups must be an array."]];
  const seen = new Set<string>(), problems: [string, string][] = [];
  groups.forEach((g, i) => {
    const path = `admin/navGroups/${i}`;
    if (!g || typeof g !== "object" || Array.isArray(g)) return problems.push([path, "A nav group is an object { id, title, order? }."]);
    const { id, title, order, ...extra } = g as Record<string, unknown>;
    if (Object.keys(extra).length) problems.push([`${path}/${Object.keys(extra)[0]}`, "A nav group has only id, title and order."]);
    if (typeof id !== "string" || !ID.test(id)) problems.push([`${path}/id`, "A nav group id is kebab-case."]);
    else if (BUILT_IN_NAV_GROUPS.has(id) || id === "settings") problems.push([`${path}/id`, `'${id}' is a built-in group; place items in it without declaring it.`]);
    else if (seen.has(id)) problems.push([`${path}/id`, `Duplicate nav group id '${id}'.`]);
    else seen.add(id);
    if (!isLocalizedText(title)) problems.push([`${path}/title`, "A nav group title is text or a { locale: text } map."]);
    if (order !== undefined && !Number.isInteger(order)) problems.push([`${path}/order`, "A nav group order is an integer."]);
  });
  return problems;
}
