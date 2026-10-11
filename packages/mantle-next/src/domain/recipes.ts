/** Core's lowered bind specs to the kernel's recipes (`kernel/binds.ts`), with each input resolved to its authored field name. */
import type { LoweredStatement } from "@aotter/mantle/spec";
import type { Recipe } from "../kernel/binds.js";

export function recipesOf(statement: LoweredStatement, fields: readonly string[], refuse: (message: string) => void): Recipe[] {
  return statement.binds.map((b): Recipe => {
    switch (b.k) {
      case "uid": case "role": case "now": return { k: b.k };
      case "cutoff": return { k: "cutoff", seconds: Number(b.seconds) };
      case "const": return { k: "const", value: b.value };
      case "input": {
        const name = fields.find(field => field.toLowerCase() === String(b.name).toLowerCase());
        if (name === undefined) refuse(`Input bind '${b.name}' has no declared field.`);
        return { k: "input", name: name ?? String(b.name), type: String(b.type) };
      }
      default: refuse(`Bind recipe '${b.k}' needs an explicit native implementation.`); return { k: "const", value: undefined };
    }
  });
}
