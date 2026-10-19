/** Caller references belong in scope or restrict, never authored SQL. */
import type { SqlNode as N } from "../model/SqlIr.js";
import type { UserFieldSpec } from "../model/UserFields.js";
import { SqlRefusal } from "./SqlRefusal.js";
const functionName = (n: N | undefined) => n?.FuncCall?.funcname?.map((v: N) => v.String.sval).join(".");
export function registerUserField(fields: Record<string, UserFieldSpec>, field: string, spec: UserFieldSpec): void {
  const old = fields[field];
  const enumKey = (values?: readonly (string | number)[]) => values ? JSON.stringify([...values].sort((a, b) => String(a).localeCompare(String(b)))) : null;
  // Two scopes binding one field must agree on its type, and on its enum when both declare one.
  if (old && (old.type !== spec.type || old.enum && spec.enum && enumKey(old.enum) !== enumKey(spec.enum)))
    throw new SqlRefusal("USER_FIELD_CONFLICT", `'${field}' is bound by Schema scopes with conflicting column types or enums.`);
  // An integer column narrows the field for every use: a fractional value matches no integer row and is refused at identity.
  const merged = old?.enum && !spec.enum ? old : spec;
  fields[field] = Object.freeze(old?.integer && !merged.integer ? { ...merged, integer: true as const } : merged);
}
export const USER_REF_SCOPE_ONLY = "auth.user() belongs in a Schema scope or this target's restrict: { <schema>: \"<column> IN auth.user('<field>')\" }, never in SQL.";
export function refuseUserReferences(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(refuseUserReferences); return; }
  if (!node || typeof node !== "object") return;
  const fn = functionName(node as N);
  if (fn === "auth.role" || fn === "auth.hasrole") throw new SqlRefusal("AUTH_ROLE_REMOVED", `${fn === "auth.role" ? "auth.role()" : "auth.hasRole()"} is removed; decide per-target permission in the application's authorize(target, caller) seam.`, (node as N).FuncCall.location);
  if (fn === "auth.user") throw new SqlRefusal("USER_REF_SCOPE_ONLY", USER_REF_SCOPE_ONLY, (node as N).FuncCall.location);
  Object.values(node).forEach(refuseUserReferences);
}
