/** Core's lowered bind specs as the kernel's recipes (`kernel/binds.ts`), each input resolved to its authored field name. */
import type { LoweredStatement } from "@aotter/mantle/spec";
import type { Recipe } from "../kernel/binds.js";

const KINDS = new Set(["uid", "role", "now", "cutoff", "const", "input"]);
/** @internal */
export function recipesOf(statement: LoweredStatement, fields: readonly string[], refuse: (message: string) => void): Recipe[] {
  return statement.binds.map(b => {
    if (!KINDS.has(b.k)) refuse(`Bind recipe '${b.k}' needs an explicit native implementation.`);
    if (b.k !== "input") return b as Recipe;
    const name = fields.find(field => field.toLowerCase() === String(b.name).toLowerCase());
    if (name === undefined) refuse(`Input bind '${b.name}' has no declared field.`);
    // only a date-time or a date is converted at bind time (`encode` in kernel/binds)
    return { k: "input", name: name ?? String(b.name), ...(b.type === "timestamptz" || b.type === "date" ? { type: b.type } : {}) };
  });
}
