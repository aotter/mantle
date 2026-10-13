/** Validate boundary JSON before converting declared binds to driver inputs. */
import type { JsonSchema, LoweredStatement, RuntimePlan } from "@aotter/mantle/compiler";
import type { Target } from "./model.js";
import { q } from "./entry.js";
/** The kernel's `Conversions` for the fields an input bind reads (see kernel/surface), as a literal; empty when none. */
export function conversions(properties: JsonSchema["properties"], binds: LoweredStatement["binds"], target: Target): string {
  const fields = Object.keys(properties ?? {}).flatMap(field => {
    const bind = binds.find(b => b.k === "input" && String(b.name).toLowerCase() === field.toLowerCase());
    if (!bind || bind.k !== "input") return [];
    const type = String(bind.type);
    return [[field, type === "json" ? "json" : type === "bool" && !target.endsWith("postgres") ? "bool" : ""]];
  });
  return fields.length ? q(fields) : "";
}

/** Only build-time authorization assembly; generated queries retain their existing predicates. @internal */
export const authLines = (requires: RuntimePlan["views"][string]["requires"], path: string): string[] => (requires?.auth?.all ?? []).map((p,index)=>{
  const allowed=typeof p === "string" ? 'caller.kind === "user"' : "ctx.auth.scope" in p ? `caller.kind === "user" && caller.scopes.includes(${q(p["ctx.auth.scope"])})` : `caller.kind === "user" && ${q(p["ctx.staff"])}.includes(caller.role ?? "")`;
  return `  deny(caller, ${allowed}, ${q(`${path}/requires/auth/all/${index}`)});`;
});
