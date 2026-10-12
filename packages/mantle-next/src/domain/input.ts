/** Validate boundary JSON before converting declared binds to driver inputs. */
import type { JsonSchema, LoweredStatement } from "@aotter/mantle/spec";
import type { Target } from "./model.js";
const q = JSON.stringify;
export function emitBoundaryInput(properties: JsonSchema["properties"], binds: LoweredStatement["binds"], target: Target): string {
  return Object.keys(properties ?? {}).flatMap(field => {
    const bind = binds.find(b => b.k === "input" && String(b.name).toLowerCase() === field.toLowerCase());
    if (!bind || bind.k !== "input") return [];
    const key = `input[${q(field)}]`, type = String(bind.type);
    return [`${key} = ${key} == null ? null : ${type === "json" ? `JSON.stringify(${key})` : type === "bool" && !target.endsWith("postgres") ? `Number(${key})` : key};`];
  }).join("\n");
}
