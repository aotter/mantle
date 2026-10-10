/**
 * Input and output validators of a sealed plan, built once per plan object (ADR-0044 decision 7). `createMantle` calls
 * this synchronously at construction, which a Workers preset runs at module scope, so `jsonSchemaToZod` is off the first
 * request. The WeakMap makes a second call with the same plan (a test, a re-created runtime) free.
 */
import type { ZodType } from "zod";
import { jsonSchemaToZod, type RuntimePlan } from "../../spec/domain/index.js";

export interface PlanValidators {
  /** By Procedure name. */
  readonly procedures: ReadonlyMap<string, { readonly input: ZodType; readonly output: ZodType }>;
  /** By View name; only Views that declare an input. */
  readonly views: ReadonlyMap<string, ZodType>;
}

const built = new WeakMap<RuntimePlan, PlanValidators>();

export function planValidators(plan: RuntimePlan): PlanValidators {
  const cached = built.get(plan);
  if (cached) return cached;
  const v: PlanValidators = {
    procedures: new Map(Object.entries(plan.procedures).map(([name, p]) => [name, { input: jsonSchemaToZod(p.input), output: jsonSchemaToZod(p.output) }])),
    views: new Map(Object.entries(plan.views).flatMap(([name, view]) => view.input ? [[name, jsonSchemaToZod(view.input)] as const] : [])),
  };
  built.set(plan, v);
  return v;
}
