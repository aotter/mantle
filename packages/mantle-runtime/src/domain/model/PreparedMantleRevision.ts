import type { PreparedMantleStorage } from "../port/MantleStorageAdapter.js";
import type { RuntimePlan } from "../service/RuntimePlanCompiler.js";

declare const preparedMantleRevision: unique symbol;

/** Exact plan plus semantic storage proven ready for that revision. */
export interface PreparedMantleRevision {
  readonly [preparedMantleRevision]: true;
  readonly plan: RuntimePlan;
  readonly storage: PreparedMantleStorage;
  /** Present when preparation validated Procedure handler availability. */
  readonly handlerNames?: readonly string[];
}

export function sealPreparedMantleRevision(
  plan: RuntimePlan,
  storage: PreparedMantleStorage,
  handlerNames?: readonly string[],
): PreparedMantleRevision {
  return Object.freeze({
    plan,
    storage,
    ...(handlerNames ? { handlerNames: Object.freeze([...new Set(handlerNames)].sort()) } : {}),
  }) as PreparedMantleRevision;
}
