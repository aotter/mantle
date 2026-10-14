/** Validate boundary JSON before converting declared binds to driver inputs. */
import type { JsonSchema, LoweredStatement, RuntimePlan } from "../build/compiler.js";
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
export const authLines = (requires: RuntimePlan["views"][string]["requires"], path: string, binds: LoweredStatement["binds"] = [], sqlite = true, trustedOnly = false): string[] => [...(trustedOnly ? [`  deny(caller, caller.kind === "system", ${q(path)});`] : []), ...(requires?.auth?.all ?? []).map((p,index)=>{
  const allowed=typeof p === "string" ? p === "ctx.admin" ? 'isAdmin(caller)' : 'isUser(caller)' : `caller.kind === "user" && caller.scopes.includes(${q(p["ctx.auth.scope"])})`;
  return `  deny(caller, ${allowed}, ${q(`${path}/requires/auth/all/${index}`)});`;
}), ...binds.filter(b => b.k === "user").map(b => `  userBinds(${sqlite})(${q(b)}, caller);`)];
