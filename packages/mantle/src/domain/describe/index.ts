import type { RuntimePlan } from "../../build/compiler.js";
import type { PlanRestrict } from "../../build/spec/domain/model/RuntimePlan.js";
import type { UserFieldSpec } from "../../build/spec/domain/model/UserFields.js";
import { canonical, hash, hashDefinition } from "./target-hash.js";
import { targetDefinitions, type TargetDefinition } from "./targets.js";
export { targetHash } from "./target-hash.js";

export interface FieldBinding {
  via: "scope" | "restrict";
  schemas: string[];
  op: "in" | "eq";
  allAllowed: boolean;
}
export interface DescribeTarget {
  name: string;
  title: string;
  description: string;
  inputSchema: import("../../build/compiler.js").JsonSchema;
  annotations: import("../../build/spec/domain/model/ManifestGrammar.js").ProcedureMcpAnnotations;
  _meta: {
    surface: string; surfaces: string[]; triggers: TargetDefinition["triggers"]; kind: string; id: string; targetHash: string; readOnly: boolean;
    userFields: Record<string, FieldBinding>;
    scope: PlanRestrict; restrict: PlanRestrict;
    opaque: boolean; ownerScoped: boolean; unscopedReads: boolean; hostCallable: boolean; trustedOnly: boolean;
    variants: { id: string; scope: PlanRestrict; restrict: PlanRestrict; requires: Requirements; inputSchema: DescribeTarget["inputSchema"];
      readOnly: boolean; hostCallable: boolean; trustedOnly: boolean; opaque: boolean; unscopedReads: boolean }[];
    requires: Requirements;
    requiresBySurface: Record<string, Requirements>;
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
  planHash: string;
  access: Record<string, UserFieldSpec & { op: "in" | "eq"; scope: string[]; restrict: string[] }>;
  targets: DescribeTarget[];
}

/** A report of sealed declarations; no SQL or row values leave this function. */
export async function describeApp(plan: RuntimePlan): Promise<AppDescription> {
  const access: AppDescription["access"] = {};
  const targets = await Promise.all(targetDefinitions(plan).map(async d => {
    const scope = Object.fromEntries(d.schemas.map(name => {
      const s = plan.schemas[name]!;
      return [name, { ...(s.scope ? { owner: s.scope } : {}), terms: s.userScopes ?? [] }];
    }));
    const userFields: Record<string, FieldBinding> = {};
    for (const [via, policies] of [["scope", scope], ["restrict", d.restrict]] as const) {
      for (const [name, policy] of Object.entries(policies)) {
        const schema = plan.schemas[name]!;
        const fields = [...policy.terms.map(t => ({ field: t.field, type: t.type, op: "in" as const }))];
        for (const term of fields) {
          const prior = userFields[term.field];
          userFields[term.field] = { via: prior?.via === "restrict" || via === "restrict" ? "restrict" : "scope", schemas: [...new Set([...(prior?.schemas ?? []), schema.name])].sort(), op: term.op, allAllowed: term.op === "in" && via === "scope" && prior?.allAllowed !== false };
          const a = access[term.field] ??= { ...(plan.access?.userFields[term.field] ?? { type: term.type, multiple: term.op === "in" }), op: term.op, scope: [], restrict: [] };
          const use = via === "scope" ? schema.name : d.id;
          if (!a[via].includes(use)) a[via].push(use);
        }
      }
    }
    return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations: { ...d.annotations, readOnlyHint: d.readOnly }, _meta: {
      surface: d.surface, surfaces: d.surfaces, triggers: d.triggers, kind: d.kind, id: d.id, targetHash: await hashDefinition(plan, d), readOnly: d.readOnly, userFields, scope, restrict: d.restrict,
      opaque: d.opaque, ownerScoped: d.readSchemas.some(name => !!plan.schemas[name]?.scope), unscopedReads: d.readSchemas.some(name => !plan.schemas[name]?.scope && !plan.schemas[name]?.userScopes?.length), hostCallable: d.hostCallable,
      trustedOnly: d.trustedOnly,
      variants: d.variants.map(v => ({ id: v.id, restrict: v.restrict, requires: requirements(v, d.surface), inputSchema: v.inputSchema,
        readOnly: v.readOnly, hostCallable: v.hostCallable, trustedOnly: v.trustedOnly, opaque: v.opaque,
        unscopedReads: v.readSchemas.some(name => !plan.schemas[name]?.scope && !plan.schemas[name]?.userScopes?.length),
        scope: Object.fromEntries(v.schemas.map(name => { const s = plan.schemas[name]!; return [name, { ...(s.scope ? { owner: s.scope } : {}), terms: s.userScopes ?? [] }]; })) })),
      requires: requirements(d, d.surface), requiresBySurface: Object.fromEntries(d.surfaces.map(surface => [surface, requirements(d, surface)])),
    } };
  }));
  // Fields used only by Schemas still belong to the application vocabulary. The owner term (`= auth.uid()`) is not a user field: it shows as `scope.<schema>.owner`.
  for (const s of Object.values(plan.schemas)) for (const term of [...(s.userScopes ?? []).map(t => ({ field: t.field, type: t.type, op: "in" as const }))]) {
    const a = access[term.field] ??= { ...(plan.access?.userFields[term.field] ?? { type: term.type, multiple: term.op === "in" }), op: term.op, scope: [], restrict: [] };
    if (!a.scope.includes(s.name)) a.scope.push(s.name);
  }
  for (const a of Object.values(access)) { a.scope.sort(); a.restrict.sort(); }
  const { fingerprint: _fingerprint, ...body } = plan;
  return JSON.parse(canonical({ schemaVersion: 1, planHash: await hash(body), access, targets })) as AppDescription;
}

export interface AppChange { id: string; field: string; direction: "widened" | "narrowed" | "changed"; before?: unknown; after?: unknown }
type Direction = AppChange["direction"];
const securityFlags = ["readOnly", "hostCallable", "trustedOnly", "opaque", "unscopedReads"] as const;
const flagDirection = (field: typeof securityFlags[number], value: boolean): Direction => (field === "readOnly" || field === "trustedOnly" ? !value : value) ? "widened" : "narrowed";
// Constraints are conjunctive. Exposure sets have the opposite direction.
const inclusion = (before: string[], after: string[]): Direction => before.every(t => after.includes(t)) && after.every(t => before.includes(t)) ? "changed" : before.every(t => after.includes(t)) ? "narrowed" : after.every(t => before.includes(t)) ? "widened" : "changed";
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
/** Only classify input changes we can prove from supported JSON Schema constraints. */
function inputDirection(x: DescribeTarget["inputSchema"], y: DescribeTarget["inputSchema"]): Direction {
  const directions: Direction[] = [];
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const a = x[key], b = y[key];
    if (canonical(a) === canonical(b)) continue;
    if (key === "title" || key === "description" || key === "default" || key === "examples") continue;
    if (key === "required") directions.push(inclusion((a ?? []) as string[], (b ?? []) as string[]));
    else if (key === "enum" || key === "type") directions.push(b === undefined ? "widened" : a === undefined ? "narrowed" : inclusion((Array.isArray(b) ? b : [b]).map(canonical), (Array.isArray(a) ? a : [a]).map(canonical)));
    else if (["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"].includes(key)) directions.push(b === undefined || a !== undefined && Number(b) < Number(a) ? "widened" : "narrowed");
    else if (["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"].includes(key)) directions.push(b === undefined || a !== undefined && Number(b) > Number(a) ? "widened" : "narrowed");
    else if (key === "additionalProperties" && (typeof a === "boolean" || a === undefined) && (typeof b === "boolean" || b === undefined)) directions.push(b === false ? "narrowed" : "widened");
    else if (["const", "pattern", "format", "multipleOf", "uniqueItems"].includes(key) && (a === undefined || b === undefined)) directions.push(b === undefined ? "widened" : "narrowed");
    else if (key === "properties") {
      const old = x.properties ?? {}, next = y.properties ?? {};
      for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (canonical(old[name]) === canonical(next[name])) continue;
        if (old[name] && next[name]) directions.push(inputDirection(old[name]!, next[name]!));
        else directions.push("changed");
      }
    } else directions.push("changed");
  }
  return directions.length && directions.every(d => d === "widened") ? "widened" : directions.length && directions.every(d => d === "narrowed") ? "narrowed" : "changed";
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
    record("requiresBySurface", x.requiresBySurface, y.requiresBySurface, combine(Object.keys(x.requiresBySurface).filter(s => y.requiresBySurface[s]).map(s => requiresDirection(x.requiresBySurface[s]!, y.requiresBySurface[s]!))));
    for (const field of securityFlags) record(field, x[field], y[field], flagDirection(field, y[field]));
    const flags = (fields: typeof x.userFields) => Object.fromEntries(Object.entries(fields).map(([name, binding]) => [name, binding.allAllowed]));
    const fields = [...new Set([...Object.keys(x.userFields), ...Object.keys(y.userFields)])];
    record("allAllowed", flags(x.userFields), flags(y.userFields), inclusion(fields.filter(f => y.userFields[f]?.allAllowed !== false), fields.filter(f => x.userFields[f]?.allAllowed !== false)));
    record("inputSchema", before.inputSchema, after.inputSchema, inputDirection(before.inputSchema, after.inputSchema));
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
        if (canonical(left.inputSchema) !== canonical(right.inputSchema)) directions.push(inputDirection(left.inputSchema, right.inputSchema));
        for (const field of securityFlags) if (left[field] !== right[field]) directions.push(flagDirection(field, right[field]));
      }
    }
    record("variants", x.variants, y.variants, combine(directions));
    if (changes.length === start && x.targetHash !== y.targetHash) changes.push({ id, field: "behavior", direction: "changed" });
  }
  return changes;
}
