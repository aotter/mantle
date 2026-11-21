import type { RuntimePlan } from "../build/compiler.js";
/** Conditional capability imports keep applications without user references unchanged. */
export function userReferences(plan: RuntimePlan, sqlite: boolean): { used: boolean; code: string; values: string } {
  const used = !!plan.access;
  // A restrict OR-clause binds `any` recipes, which an older runtime would misread: such output needs USER_REFS_V2
  // (ADR-0046 §11, #2105), so that runtime fails to link. Output without one keeps V1, byte for byte.
  const version = [...Object.values(plan.views), ...Object.values(plan.procedures)].some(t =>
    Object.values(t.restrict ?? {}).some(r => r.or?.length),
  )
    ? 2
    : 1;
  return {
    used,
    code: used
      ? `import * as USER from "@aotter/mantle/internal/user-fields";\nconst USER_VALUES = { scopeInsert: USER.scopeInsert, scopedAll: USER.scopedAll, userRefs: USER.userRefs(${sqlite}, ${version}) };`
      : "",
    values: used ? "...USER_VALUES" : "",
  };
}
