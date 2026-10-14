import type { RuntimePlan } from "../../build/compiler.js";
import type { PlanRestrict } from "../../build/spec/domain/model/RuntimePlan.js";
import type { UserFieldSpec } from "../../build/spec/domain/model/UserFields.js";
import { canonical, hashDefinition } from "./target-hash.js";
import { targetDefinitions, type TargetDefinition } from "./targets.js";
export { targetHash } from "./target-hash.js";

export interface DescribeTarget {
  name: string;
  title: string;
  description: string;
  inputSchema: import("../../build/compiler.js").JsonSchema;
  annotations: import("../../build/spec/domain/model/ManifestGrammar.js").ProcedureMcpAnnotations;
  _meta: {
    surfaces: string[]; triggers: TargetDefinition["triggers"]; id: string; targetHash: string; readOnly: boolean;
    scope: PlanRestrict; restrict: PlanRestrict;
    opaque: boolean; unscopedReads: boolean; trustedOnly: boolean;
    variants: { id: string; scope: PlanRestrict; restrict: PlanRestrict; requires: Requirements; inputSchema: DescribeTarget["inputSchema"];
      readOnly: boolean; trustedOnly: boolean; opaque: boolean; unscopedReads: boolean }[];
    requires: Requirements;
  };
}
interface Requirements { all: readonly (string | { readonly "ctx.auth.scope": string })[]; guard?: string }
function requirements(d: TargetDefinition, surface: string): Requirements {
  const all = d.requires?.auth?.all ?? [];
  return { all: surface === "admin" && !all.includes("ctx.admin") ? ["ctx.admin", ...all] : all,
    ...(d.requires?.guard ? { guard: d.requires.guard.procedure } : {}) };
}
export interface AppDescription {
  schemaVersion: 1;
  access: Readonly<Record<string, UserFieldSpec>>;
  targets: DescribeTarget[];
}

/** A report of sealed declarations; no SQL or row values leave this function. */
export async function describeApp(plan: RuntimePlan): Promise<AppDescription> {
  const targets = await Promise.all(targetDefinitions(plan).map(async d => {
    const scope = Object.fromEntries(d.schemas.map(name => {
      const s = plan.schemas[name]!;
      return [name, { ...(s.scope ? { owner: s.scope } : {}), terms: s.userScopes ?? [] }];
    }));
    return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations: { ...d.annotations, readOnlyHint: d.readOnly }, _meta: {
      surfaces: d.surfaces, triggers: d.triggers, id: d.id, targetHash: await hashDefinition(plan, d), readOnly: d.readOnly, scope, restrict: d.restrict,
      opaque: d.opaque, unscopedReads: d.readSchemas.some(name => !plan.schemas[name]?.scope && !plan.schemas[name]?.userScopes?.length),
      trustedOnly: d.trustedOnly,
      variants: d.variants.map(v => ({ id: v.id, restrict: v.restrict, requires: requirements(v, d.surface), inputSchema: v.inputSchema,
        readOnly: v.readOnly, trustedOnly: v.trustedOnly, opaque: v.opaque,
        unscopedReads: v.readSchemas.some(name => !plan.schemas[name]?.scope && !plan.schemas[name]?.userScopes?.length),
        scope: Object.fromEntries(v.schemas.map(name => { const s = plan.schemas[name]!; return [name, { ...(s.scope ? { owner: s.scope } : {}), terms: s.userScopes ?? [] }]; })) })),
      requires: requirements(d, d.surface),
    } };
  }));
  return JSON.parse(canonical({ schemaVersion: 1, access: plan.access?.userFields ?? {}, targets })) as AppDescription;
}

export interface AppChange { id: string; field: string; direction: "widened" | "narrowed" | "changed"; before?: unknown; after?: unknown }
type Direction = AppChange["direction"];
const securityFlags = ["readOnly", "trustedOnly", "opaque", "unscopedReads"] as const;
const flagDirection = (field: typeof securityFlags[number], value: boolean): Direction => (field === "readOnly" || field === "trustedOnly" ? !value : value) ? "widened" : "narrowed";
// Exposure sets have the opposite direction.
// Constraints are conjunctive: losing any term widens, even when another term is added (a swap is still a widening).
const inclusion = (before: string[], after: string[]): Direction => before.some(t => !after.includes(t)) ? "widened" : after.some(t => !before.includes(t)) ? "narrowed" : "changed";
const exposureDirection = (before: string[], after: string[]): Direction => after.some(t => !before.includes(t) && t !== canonical("internal")) ? "widened" : before.some(t => !after.includes(t) && t !== canonical("internal")) ? "narrowed" : "changed";
const combine = (directions: Direction[]): Direction => directions.includes("widened") ? "widened" : directions.length && directions.every(d => d === "narrowed") ? "narrowed" : "changed";
const terms = (p: PlanRestrict[string]) => [...(p.owner ? [canonical({ owner: p.owner })] : []), ...p.terms.map(canonical)];
function policyDirection(before: PlanRestrict, after: PlanRestrict, scope: boolean): Direction {
  const directions: Direction[] = [];
  for (const schema of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const x = before[schema], y = after[schema];
    if (canonical(x) === canonical(y)) continue;
    directions.push(scope && (!x || !y) ? x ? "narrowed" : "widened" : inclusion(x ? terms(x) : [], y ? terms(y) : []));
  }
  return combine(directions);
}
function requiresDirection(x: Requirements, y: Requirements): Direction {
  const directions: Direction[] = [];
  if (canonical(x.all) !== canonical(y.all)) directions.push(inclusion(x.all.map(canonical), y.all.map(canonical)));
  if (x.guard !== y.guard) directions.push(!y.guard ? "widened" : !x.guard ? "narrowed" : "changed");
  return combine(directions);
}
/** Report widening on any reachable surface or dispatcher variant. */
export function diffApp(a: AppDescription, b: AppDescription): AppChange[] {
  if (a.schemaVersion !== 1 || b.schemaVersion !== 1) throw new TypeError("Unsupported describe schemaVersion.");
  const changes: AppChange[] = [], old = new Map(a.targets.map(t => [t._meta.id, t])), next = new Map(b.targets.map(t => [t._meta.id, t]));
  for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const before = old.get(id), after = next.get(id);
    if (!before || !after) { changes.push({ id, field: "target", direction: before ? "narrowed" : "widened" }); continue; }
    const x = before._meta, y = after._meta, start = changes.length;
    const record = (field: string, left: unknown, right: unknown, direction: Direction) => {
      if (canonical(left) !== canonical(right)) changes.push({ id, field, direction, before: left, after: right });
    };
    record("scope", x.scope, y.scope, policyDirection(x.scope, y.scope, true));
    record("restrict", x.restrict, y.restrict, policyDirection(x.restrict, y.restrict, false));
    record("requires", x.requires, y.requires, requiresDirection(x.requires, y.requires));
    for (const field of ["surfaces", "triggers"] as const) record(field, x[field], y[field], exposureDirection(x[field].map(canonical), y[field].map(canonical)));
    for (const field of securityFlags) record(field, x[field], y[field], flagDirection(field, y[field]));
    record("inputSchema", before.inputSchema, after.inputSchema, "changed");
    const directions: Direction[] = [];
    const variants = new Map(x.variants.map(v => [v.id, v])), added = new Map(y.variants.map(v => [v.id, v]));
    for (const name of new Set([...variants.keys(), ...added.keys()])) {
      const left = variants.get(name), right = added.get(name);
      if (canonical(left) === canonical(right)) continue;
      if (!left || !right) directions.push(left ? "narrowed" : "widened");
      else {
        if (canonical(left.scope) !== canonical(right.scope)) directions.push(policyDirection(left.scope, right.scope, true));
        if (canonical(left.restrict) !== canonical(right.restrict)) directions.push(policyDirection(left.restrict, right.restrict, false));
        if (canonical(left.requires) !== canonical(right.requires)) directions.push(requiresDirection(left.requires, right.requires));
        if (canonical(left.inputSchema) !== canonical(right.inputSchema)) directions.push("changed");
        for (const field of securityFlags) if (left[field] !== right[field]) directions.push(flagDirection(field, right[field]));
      }
    }
    record("variants", x.variants, y.variants, combine(directions));
    if (changes.length === start && x.targetHash !== y.targetHash) changes.push({ id, field: "behavior", direction: "changed" });
  }
  return changes;
}
