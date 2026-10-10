/**
 * The lifecycle hook sets of a plan: which (Schema, operation) pairs have a before or after Trigger, and which Procedures each hook
 * fires. Boot builds them for the dispatcher, and `mantle generate` for the `returning` set an inline Procedure compiles with (ADR-0044),
 * so one loop owns both.
 */
import type { RuntimePlan } from "../../spec/domain/index.js";

const VERB = { create: "insert", update: "update", delete: "delete", publish: "publish" } as const;

/** The key of the Schema a lifecycle Trigger names, as the dispatcher keys its hooks: the name in lower case, an own key. */
export const lifecycleKey = (plan: Pick<RuntimePlan, "schemas">, schema: string): string | undefined => (Object.hasOwn(plan.schemas, schema.toLowerCase()) ? schema.toLowerCase() : undefined);

export interface LifecycleHookSets {
  readonly before: Set<string>;
  readonly after: Set<string>;
  /** `schema|hook` to the [trigger, procedure] pairs it fires */
  readonly byHook: Map<string, [string, string][]>;
}

/** The sets of a plan whose lifecycle Triggers all name a Schema of the plan (boot refuses any other). Triggers are visited by name. */
export function lifecycleHookSets(plan: Pick<RuntimePlan, "schemas" | "triggers">): LifecycleHookSets {
  const byHook = new Map<string, [string, string][]>();
  const before = new Set<string>();
  const after = new Set<string>();
  const triggers = Object.entries(plan.triggers).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [name, t] of triggers) {
    if (t.source.kind !== "lifecycle") continue;
    for (const hook of t.source.on) {
      const [stage, op] = hook.split("_") as ["before" | "after", keyof typeof VERB];
      // a statement names its table the way SQL folds it, so hooks are keyed by the lower-cased Schema name
      const schema = lifecycleKey(plan, t.source.schema)!;
      (stage === "before" ? before : after).add(`${schema}.${VERB[op]}`);
      const key = `${schema}|${hook}`;
      byHook.set(key, [...(byHook.get(key) ?? []), [name, t.procedure]]);
    }
  }
  return { before, after, byHook };
}
