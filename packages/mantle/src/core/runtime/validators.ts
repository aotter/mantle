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

/** Generated factories stay lazy; registration selects this exact plan's table before it reaches the validator cache. */
export interface GeneratedValidators {
  readonly procedure?: Readonly<Record<string, Readonly<Partial<Record<"input" | "output", () => ZodType>>>>>;
  readonly view?: Readonly<Record<string, () => ZodType>>;
}

const built = new WeakMap<object, PlanValidators>();
const generatedBuilt = new WeakMap<RuntimePlan, WeakMap<object, PlanValidators>>();

export function planValidators(plan: RuntimePlan, generated?: GeneratedValidators): PlanValidators {
  let cache = built;
  if (generated) {
    const existing = generatedBuilt.get(plan);
    cache = existing ?? new WeakMap<object, PlanValidators>();
    if (!existing) generatedBuilt.set(plan, cache);
  }
  const key = generated ?? plan;
  const cached = cache.get(key);
  if (cached) return cached;
  const made = new Map<string, ZodType>();
  const once = (key: string, schema: Parameters<typeof jsonSchemaToZod>[0], factory?: () => ZodType) => {
    let z = made.get(key);
    if (!z) made.set(key, (z = factory ? factory() : jsonSchemaToZod(schema)));
    return z;
  };
  const v: PlanValidators = {
    procedure: (name, kind) => {
      const factories = generated?.procedure && Object.hasOwn(generated.procedure, name) ? generated.procedure[name] : undefined;
      return once(`p\u0000${kind}\u0000${name}`, plan.procedures[name]![kind], factories && Object.hasOwn(factories, kind) ? factories[kind] : undefined);
    },
    view: (name) => { const input = plan.views[name]?.input; return input ? once(`v\u0000${name}`, input, generated?.view && Object.hasOwn(generated.view, name) ? generated.view[name] : undefined) : undefined; },
  };
  cache.set(key, v);
  return v;
}
