/** Core's lowered bind specs as the kernel's recipes (`kernel/binds.ts`), each input resolved to its authored field name. */
import type { LoweredStatement } from "../build/compiler.js";
import type { Recipe } from "../kernel/binds.js";

const KINDS = new Set(["uid", "role", "now", "cutoff", "const", "input", "version"]);
/** @internal */
export function recipesOf(statement: Pick<LoweredStatement,"binds">, fields: readonly string[], refuse: (message: string) => void, values?: Set<string>): Recipe[] {
  return statement.binds.map(b => {
    if (!KINDS.has(b.k)) refuse(`Bind recipe '${b.k}' needs an explicit native implementation.`);
    if (b.k === "now" || b.k === "cutoff") values?.add(b.k);
    if (b.k !== "input") return b as Recipe;
    if (b.type === "date" || b.type === "timestamptz") values?.add(b.type === "date" ? "date" : "timestamp");
    const name = fields.find(field => field.toLowerCase() === String(b.name).toLowerCase());
    if (name === undefined) refuse(`Input bind '${b.name}' has no declared field.`);
    // only a date-time or a date is converted at bind time (`encode` in kernel/binds)
    return { k: "input", name: name ?? String(b.name), ...(b.type === "timestamptz" || b.type === "date" ? { type: b.type } : {}) };
  });
}
