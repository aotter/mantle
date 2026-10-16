/** Admin sidebar placement: `uiSchema.nav.{group, order, hidden}`. Presentation only. */

/** Admin's own groups. Project groups sort among content 10, operations 20 and reports 30 by `order`; More always stays last. */
export const BUILT_IN_NAV_GROUPS: ReadonlySet<string> = new Set(["content", "operations", "reports", "more"]);
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLACEMENT: Readonly<Record<string, readonly [(value: unknown) => boolean, string]>> = {
  group: [(v) => typeof v === "string" && ID.test(v), "a kebab-case group id"],
  order: [Number.isInteger, "an integer"],
  hidden: [(v) => typeof v === "boolean", "a boolean"],
};

/** The first bad `nav` key as [key, expected], or null; `own` keys are the owner's to check. Group ids are typed by `admin-client.ts`. */
export function navPlacementProblems(nav: Readonly<Record<string, unknown>>, own: readonly string[] = []): [string, string] | null {
  const keys = [...own, ...Object.keys(PLACEMENT)];
  for (const [key, value] of Object.entries(nav)) {
    if (own.includes(key)) continue;
    const rule = Object.hasOwn(PLACEMENT, key) ? PLACEMENT[key]! : null;
    if (!rule) return [key, `${keys.slice(0, -1).join(", ")} or ${keys.at(-1)}`];
    if (!rule[0](value)) return [key, rule[1]];
  }
  return null;
}
