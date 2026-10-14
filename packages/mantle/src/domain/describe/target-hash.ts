import type { RuntimePlan } from "../../build/compiler.js";
import { targetDefinitions, type TargetDefinition } from "./targets.js";

import { canonical } from "../../build/spec/domain/service/PlanFingerprint.js";
export { canonical };

export async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function hashDefinition(plan: RuntimePlan, d: TargetDefinition): Promise<string> {
  return hash({ id: d.id, surface: d.surface, behavior: d.behavior, input: d.inputSchema, requires: d.requires, restrict: d.restrict,
    dialect: plan.dialect, schemas: Object.fromEntries(d.schemas.map(name => [name, plan.schemas[name]])),
    userFields: plan.access?.userFields, readOnly: d.readOnly, hostCallable: d.hostCallable });
}
/** Opt-in runtime export. No compiler, parser, database or Node API is loaded. */
export async function targetHash(plan: RuntimePlan, targetId: string): Promise<string> {
  const target = targetDefinitions(plan).find(d => d.id === targetId);
  if (!target) throw new TypeError(`Unknown target '${targetId}'.`);
  return hashDefinition(plan, target);
}
