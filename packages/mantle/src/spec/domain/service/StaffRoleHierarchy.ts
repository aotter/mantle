import type { StaffRole } from "../model/ManifestGrammar.js";

/**
 * Staff-role ordering: `owner > editor > contributor`. Used by
 * permission checks that want "role-or-above" semantics (e.g. "this
 * action needs at least editor").
 *
 * Lives in `domain/service/` because role-rank comparison is
 * behavior, not pure-type grammar — the `STAFF_ROLES` enum + the
 * `StaffRole` type stay in `domain/model/ManifestGrammar.ts` (those
 * are referenced by the parser).
 */
const ROLE_RANK: Record<StaffRole, number> = {
  owner: 3,
  editor: 2,
  contributor: 1,
};

export function meetsRole(actual: StaffRole, min: StaffRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}
