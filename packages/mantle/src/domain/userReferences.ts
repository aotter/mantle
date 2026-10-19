import type { RuntimePlan } from '../build/compiler.js';
/** Conditional capability imports keep applications without user references unchanged. */
export function userReferences(plan: RuntimePlan, sqlite: boolean): { used: boolean; code: string; values: string } {
  const used = !!plan.access;
  return { used, code: used ? `import * as USER from "@aotter/mantle/user-fields";\nconst USER_VALUES = { scopeInsert: USER.scopeInsert, scopedAll: USER.scopedAll, userRefs: USER.userRefs(${sqlite}, 1) };` : '', values: used ? '...USER_VALUES' : '' };
}
