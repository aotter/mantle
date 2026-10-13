/** Next caller reads apply Core's staff visibility; system/public modes retain their own rules. */
import type { RowMode } from "@aotter/mantle/compiler";
export const nextMode = (mode: RowMode): RowMode => mode === "caller" ? "staff" : mode;

/** Single OSS role; additional role policy belongs to the application. */
export const STAFF_ROLES = ["staff"] as const;
/** ADR-0046 decision 1: `staff` plus the roles the application's auth block declares; without a block, exactly STAFF_ROLES. */
export const staffRolesOf = (plan: { readonly auth?: { readonly roles: readonly string[] } }): readonly string[] =>
  plan.auth?.roles.length ? [...STAFF_ROLES, ...plan.auth.roles] : STAFF_ROLES;

