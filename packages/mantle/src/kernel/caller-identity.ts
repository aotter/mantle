import type { Caller } from "./contracts.js";
import type { UserValue } from "./user-fields.js";
type Identity = { readonly roles: readonly string[]; readonly fields: Readonly<Record<string, UserValue>>; readonly admin: boolean; readonly impersonatedBy?: string; readonly host?: true };
export const identities = /* @__PURE__ */ new WeakMap<Caller, Identity>();


export const isHostCaller = (caller: Caller): boolean => identities.get(caller)?.host === true;
export const rolesOf = (caller: Caller): readonly string[] => identities.get(caller)?.roles ?? [];
// Unbranded callers get a fresh empty map; mutating it cannot grant authority.
export const fieldsOf = (caller: Caller): Readonly<Record<string, UserValue>> => identities.get(caller)?.fields ?? {};
export const valueFor = (caller: Caller, field: string): UserValue | undefined => identities.get(caller)?.fields[field];
export const hasRole = (caller: Caller, role: string): boolean => rolesOf(caller).includes(role);
export const isAdminCaller = (caller: Caller): caller is Extract<Caller, { kind: "user" | "host" }> & { readonly admin: true } => !!identities.get(caller)?.admin;
