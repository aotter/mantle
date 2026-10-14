import type { RuntimePlan } from "../../build/compiler.js";
import type { PlanRestrict } from "../../build/spec/domain/model/RuntimePlan.js";
import type { UserFieldSpec } from "../../build/spec/domain/model/UserFields.js";
import { canonical, hash, hashDefinition } from "./target-hash.js";
import { targetDefinitions } from "./targets.js";
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
    surface: string; kind: string; id: string; targetHash: string; readOnly: boolean;
    userFields: Record<string, FieldBinding>;
    scope: PlanRestrict; restrict: PlanRestrict;
    opaque: boolean; ownerScoped: boolean; unscopedReads: boolean; hostCallable: boolean;
    variants: { id: string; scope: PlanRestrict; restrict: PlanRestrict; requires: unknown }[];
    requires: { all: readonly (string | { readonly "ctx.auth.scope": string })[]; guard?: string };
  };
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
      surface: d.surface, kind: d.kind, id: d.id, targetHash: await hashDefinition(plan, d), readOnly: d.readOnly, userFields, scope, restrict: d.restrict,
      opaque: d.opaque, ownerScoped: d.readSchemas.some(name => !!plan.schemas[name]?.scope), unscopedReads: d.readSchemas.some(name => !plan.schemas[name]?.scope && !plan.schemas[name]?.userScopes?.length), hostCallable: d.hostCallable,
      variants: d.variants.map(v => ({ id: v.id, restrict: v.restrict, requires: v.requires ?? {}, scope: Object.fromEntries(v.schemas.map(name => { const s = plan.schemas[name]!; return [name, { ...(s.scope ? { owner: s.scope } : {}), terms: s.userScopes ?? [] }]; })) })),
      requires: { all: d.surface === "admin" && !d.requires?.auth?.all.includes("ctx.admin") ? ["ctx.admin", ...(d.requires?.auth?.all ?? [])] : d.requires?.auth?.all ?? [], ...(d.requires?.guard ? { guard: d.requires.guard.procedure } : {}) },
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
/** Classify set inclusion only; incomparable or opaque changes remain changed. */
export function diffApp(a: AppDescription, b: AppDescription): AppChange[] {
  if (a.schemaVersion !== 1 || b.schemaVersion !== 1) throw new TypeError("Unsupported describe schemaVersion.");
  const changes: AppChange[] = [], old = new Map(a.targets.map(t => [t._meta.id, t._meta])), next = new Map(b.targets.map(t => [t._meta.id, t._meta]));
  const terms = (v: unknown): string[] => {
    if (!v || typeof v !== "object") return [];
    return Object.entries(v).flatMap(([schema, p]) => {
      const policy = p as { owner?: string; terms: unknown[] };
      return [...(policy.owner ? [canonical({ schema, owner: policy.owner })] : []), ...policy.terms.map(term => canonical({ schema, term }))];
    });
  };
  const inclusion = (before: string[], after: string[]): AppChange["direction"] => before.every(t => after.includes(t)) && after.every(t => before.includes(t)) ? "changed" : before.every(t => after.includes(t)) ? "narrowed" : after.every(t => before.includes(t)) ? "widened" : "changed";
  for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const x = old.get(id), y = next.get(id);
    if (!x || !y) { changes.push({ id, field: "target", direction: x ? "narrowed" : "widened" }); continue; }
    const start = changes.length;
    for (const field of ["scope", "restrict", "readOnly", "requires", "userFields", "variants"] as const) {
      const flags = (fields: typeof x.userFields) => Object.fromEntries(Object.entries(fields).map(([name, binding]) => [name, binding.allAllowed]));
      if (canonical(field === "userFields" ? flags(x.userFields) : x[field]) === canonical(field === "userFields" ? flags(y.userFields) : y[field])) continue;
      let direction: AppChange["direction"] = "changed";
      if (field === "scope" || field === "restrict") direction = inclusion(terms(x[field]), terms(y[field]));
      if (field === "requires" && x.requires.guard === y.requires.guard) direction = inclusion(x.requires.all.map(canonical), y.requires.all.map(canonical));
      if (field === "readOnly") direction = y.readOnly ? "narrowed" : "widened";
      if (field === "userFields") {
        const ids = [...new Set([...Object.keys(x.userFields), ...Object.keys(y.userFields)])];
        const before = ids.filter(f => x.userFields[f]?.allAllowed !== false), after = ids.filter(f => y.userFields[f]?.allAllowed !== false);
        direction = canonical(before) === canonical(after) ? "changed" : inclusion(after, before);
      }
      changes.push({ id, field: field === "userFields" ? "allAllowed" : field, direction, before: x[field], after: y[field] });
    }
    if (changes.length === start && x.targetHash !== y.targetHash) changes.push({ id, field: "behavior", direction: "changed" });
  }
  return changes;
}
