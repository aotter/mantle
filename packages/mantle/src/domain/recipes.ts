/** Core's lowered bind specs as the kernel's recipes (`kernel/binds.ts`), each input resolved to its authored field name. */
import type { LoweredStatement } from "../build/compiler.js";
import type { Recipe } from "../kernel/binds.js";

const KINDS = new Set(["uid", "admin", "user", "now", "cutoff", "const", "input", "version", "scoped"]);
/** @internal */
export function recipesOf(statement: Pick<LoweredStatement,"binds">, fields: readonly string[], refuse: (message: string) => void, values?: Set<string>): Recipe[] {
  const field = (bound: unknown) => {
    const name = fields.find(field => field.toLowerCase() === String(bound).toLowerCase());
    if (name === undefined) refuse(`Input bind '${bound}' has no declared field.`);
    return name ?? String(bound);
  };
  return statement.binds.map(b => {
    if (!KINDS.has(b.k)) refuse(`Bind recipe '${b.k}' needs an explicit native implementation.`);
    if (b.k === "now" || b.k === "cutoff") values?.add(b.k);
    if (b.k === "scoped" && b.name !== undefined) return { ...b, name: field(b.name) } as Recipe;
    if (b.k !== "input") return b as Recipe;
    if (b.type === "date" || b.type === "timestamptz") values?.add(b.type === "date" ? "date" : "timestamp");
    // only a date-time, a date or JSON is converted at bind time (`encode` in kernel/binds)
    return { k: "input", name: field(b.name), ...(b.type === "timestamptz" || b.type === "date" || b.type === "json" ? { type: b.type } : {}) };
  });
}
