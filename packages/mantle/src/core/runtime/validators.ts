/**
 * Input and output validators of a sealed plan, each built on its first use and kept per plan object (ADR-0044 decision 7, as
 * amended). A cold isolate pays `jsonSchemaToZod` only for the entries its first request reaches, not for every Procedure and
 * View in the plan; the WeakMap makes later runtimes over the same plan (a test, a re-created runtime) share what was built.
 */
import type { ZodType } from "zod";
import { jsonSchemaToZod, type RuntimePlan } from "../../spec/domain/index.js";

export interface PlanValidators {
  /** A Procedure's input or output validator. */
  procedure(name: string, kind: "input" | "output"): ZodType;
  /** A View's input validator; only for a View that declares an input. */
  view(name: string): ZodType | undefined;
}

const built = new WeakMap<RuntimePlan, PlanValidators>();

export function planValidators(plan: RuntimePlan): PlanValidators {
  const cached = built.get(plan);
  if (cached) return cached;
  const made = new Map<string, ZodType>();
  const once = (key: string, schema: Parameters<typeof jsonSchemaToZod>[0]) => {
    let z = made.get(key);
    if (!z) made.set(key, (z = jsonSchemaToZod(schema)));
    return z;
  };
  const v: PlanValidators = {
    procedure: (name, kind) => once(`p\u0000${kind}\u0000${name}`, plan.procedures[name]![kind]),
    view: (name) => { const input = plan.views[name]?.input; return input ? once(`v\u0000${name}`, input) : undefined; },
  };
  built.set(plan, v);
  return v;
}
