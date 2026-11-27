import type { RuntimePlan } from "../../build/compiler.js";
import type { PlanRestrict } from "../../build/spec/domain/model/RuntimePlan.js";
import type { UserFieldSpec } from "../../build/spec/domain/model/UserFields.js";
import { canonical, fingerprinter, requirements, TARGET_HASH_VERSION } from "./target-hash.js";
import type { RestBinding } from "../binding.js";
import { targetDefinitions, type TargetDefinition } from "./targets.js";
import { localizedSchema } from "../../kernel/localized-schema.js";
export { matchTarget, type TargetRequest } from "./match.js";

export interface DescribeTarget {
  name: string;
  title: string;
  description: string;
  inputSchema: import("../../build/compiler.js").JsonSchema;
  annotations: import("../../build/spec/domain/model/ManifestGrammar.js").ProcedureMcpAnnotations;
  _meta: {
    [key: string]: unknown;
    surfaces: string[];
    triggers: TargetDefinition["triggers"];
    id: string;
    /** The runtime pin (formula `targetHashVersion`). */
    targetHash: string;
    /** ADR-0047 §7; absent in reports from before formula 2, which readers treat as unknown. */
    behaviorHash?: string;
    exposureHash?: string;
    /** Formula 1's `targetHash`, carried through the 0.2.x line for diffs across the formula change. */
    targetHashV1?: string;
    /** How a `rest:` entry binds a request. */
    exposure?: RestBinding;
    readOnly: boolean;
    scope: PlanRestrict;
    restrict: PlanRestrict;
    opaque: boolean;
    nativeDatabase: boolean;
    unscopedReads: boolean;
    trustedOnly: boolean;
    variants: {
      id: string;
      scope: PlanRestrict;
      restrict: PlanRestrict;
      requires: Requirements;
      inputSchema: DescribeTarget["inputSchema"];
      readOnly: boolean;
      trustedOnly: boolean;
      opaque: boolean;
      nativeDatabase: boolean;
      unscopedReads: boolean;
    }[];
    requires: Requirements;
  };
}
interface Requirements {
  all: readonly (string | { readonly "ctx.auth.scope": string })[];
}
export interface AppDescription {
  schemaVersion: 1;
  /** The `targetHash` formula; absent means 1. */
  targetHashVersion?: number;
  access: Readonly<Record<string, UserFieldSpec>>;
  targets: DescribeTarget[];
}

const listed = (schema: DescribeTarget["inputSchema"]) =>
  localizedSchema(schema, "en") as DescribeTarget["inputSchema"];
/** A report of sealed declarations; no SQL or row values leave this function. */
export async function describeApp(plan: RuntimePlan): Promise<AppDescription> {
  const scope = (d: TargetDefinition) =>
    Object.fromEntries(
      d.schemas.map(name => {
        const s = plan.schemas[name]!;
        return [name, { ...(s.scope ? { owner: s.scope } : {}), terms: s.userScopes ?? [] }];
      }),
    );
  const unscopedReads = (d: TargetDefinition) =>
    d.readSchemas.some(name => !plan.schemas[name]?.scope && !plan.schemas[name]?.userScopes?.length);
  const fingerprints = fingerprinter(plan);
  const targets = await Promise.all(
    targetDefinitions(plan).map(async d => ({
      name: d.name,
      title: d.title,
      description: d.description,
      // A host may list targets as MCP tools: labels in `en`, like `title`; the hash keeps the definition's maps.
      inputSchema: listed(d.inputSchema),
      annotations: { ...d.annotations, readOnlyHint: d.readOnly },
      _meta: {
        ...d.toolMeta,
        surfaces: d.surfaces,
        triggers: d.triggers,
        id: d.id,
        ...(await fingerprints(d)),
        ...(d.binding ? { exposure: d.binding } : {}),
        readOnly: d.readOnly,
        scope: scope(d),
        restrict: d.restrict,
        opaque: d.opaque,
        nativeDatabase: !!d.nativeDatabase,
        unscopedReads: unscopedReads(d),
        trustedOnly: d.trustedOnly,
        variants: d.variants.map(v => ({
          id: v.id,
          restrict: v.restrict,
          requires: requirements(v, d.surface),
          inputSchema: listed(v.inputSchema),
          readOnly: v.readOnly,
          trustedOnly: v.trustedOnly,
          opaque: v.opaque,
          nativeDatabase: !!v.nativeDatabase,
          unscopedReads: unscopedReads(v),
          scope: scope(v),
        })),
        requires: requirements(d, d.surface),
      },
    })),
  );
  return JSON.parse(
    canonical({
      schemaVersion: 1,
      targetHashVersion: TARGET_HASH_VERSION,
      access: plan.access?.userFields ?? {},
      targets,
    }),
  ) as AppDescription;
}

export interface AppChange {
  id: string;
  field: string;
  direction: "widened" | "narrowed" | "changed";
  before?: unknown;
  after?: unknown;
  /** Set when a report carries no value to compare across a formula change (ADR-0047 §8.6). */
  unverified?: true;
}
type Direction = AppChange["direction"];
const securityFlags = ["readOnly", "trustedOnly", "opaque", "unscopedReads", "nativeDatabase"] as const;
const flagDirection = (field: (typeof securityFlags)[number], value: boolean): Direction =>
  (field === "readOnly" || field === "trustedOnly" ? !value : value) ? "widened" : "narrowed";
// Exposure sets have the opposite direction.
// Constraints are conjunctive: losing any term widens, even when another term is added (a swap is still a widening).
const inclusion = (before: string[], after: string[]): Direction =>
  before.some(t => !after.includes(t)) ? "widened" : after.some(t => !before.includes(t)) ? "narrowed" : "changed";
const exposureDirection = (before: string[], after: string[]): Direction =>
  after.some(t => !before.includes(t) && t !== canonical("internal"))
    ? "widened"
    : before.some(t => !after.includes(t) && t !== canonical("internal"))
      ? "narrowed"
      : "changed";
const combine = (directions: Direction[]): Direction =>
  directions.includes("widened")
    ? "widened"
    : directions.length && directions.every(d => d === "narrowed")
      ? "narrowed"
      : "changed";
/** A policy as an AND of OR-clauses, each a list of terms; a single-term clause (`owner`, `terms`) is a clause of one. */
const clauses = (p: PlanRestrict[string] | undefined): string[][] =>
  p
    ? [
        ...(p.owner ? [[canonical({ owner: p.owner })]] : []),
        ...p.terms.map(t => [canonical(t)]),
        ...(p.or ?? []).map(c => c.map(canonical)),
      ]
    : [];
// Clause `c` follows from clause `d` when every disjunct of `d` is one of `c`'s.
const implied = (c: string[], by: string[][]) => by.some(d => d.every(t => c.includes(t)));
// A clause of `before` that `after` does not imply may admit new rows: widened, even when another clause narrows (a swap
// is still a widening). Otherwise a clause of `after` that `before` does not imply narrows; else the rows are the same.
const clauseDirection = (before: string[][], after: string[][]): Direction =>
  before.some(c => !implied(c, after)) ? "widened" : after.some(c => !implied(c, before)) ? "narrowed" : "changed";
/** The `IN auth.user(...)` terms, wherever they stand: each refuses some callers before SQL (`{ all: true }`, a host
 *  that did not forward the field), whatever rows the rest of the policy matches. */
const fieldTerms = (p: PlanRestrict[string] | undefined): string[] =>
  p ? [...p.terms, ...(p.or ?? []).flat().filter(t => !("owner" in t))].map(canonical) : [];
/**
 * A Schema's direction: its rows, then the callers refused before SQL (#2128). Widened rows stay widened. A user-field term
 * that disappears admits callers it refused: with fewer rows for the rest, or with a term that refuses others added, no
 * direction holds (`changed`); with the same rows it widens. A user-field term that appears only refuses more callers.
 */
function schemaDirection(x: PlanRestrict[string] | undefined, y: PlanRestrict[string] | undefined): Direction {
  const rows = clauseDirection(clauses(x), clauses(y));
  if (rows === "widened") return rows;
  const before = fieldTerms(x),
    after = fieldTerms(y),
    admits = before.some(t => !after.includes(t)),
    refuses = after.some(t => !before.includes(t));
  if (rows === "narrowed") return admits ? "changed" : "narrowed";
  return admits ? (refuses ? "changed" : "widened") : refuses ? "narrowed" : "changed";
}
function policyDirection(before: PlanRestrict, after: PlanRestrict, scope: boolean): Direction {
  const directions: Direction[] = [];
  for (const schema of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const x = before[schema],
      y = after[schema];
    if (canonical(x) === canonical(y)) continue;
    directions.push(scope && (!x || !y) ? (x ? "narrowed" : "widened") : schemaDirection(x, y));
  }
  return combine(directions);
}
const requiresDirection = (x: Requirements, y: Requirements): Direction =>
  inclusion(x.all.map(canonical), y.all.map(canonical));
/** SchemaVersion 1 reports saved before #2048 have no native database declaration. */
const nativeDatabaseDefaults = (m: DescribeTarget["_meta"]): DescribeTarget["_meta"] => ({
  ...m,
  nativeDatabase: m.nativeDatabase ?? false,
  variants: m.variants.map(v => ({ ...v, nativeDatabase: v.nativeDatabase ?? false })),
});
/** An http Trigger's path does not widen or narrow its exposure: a path-only move is `changed` (ADR-0047 §8.5). */
const triggerKey = (t: DescribeTarget["_meta"]["triggers"][number]) =>
  canonical(t.source.kind === "http" ? { ...t, source: { ...t.source, path: undefined } } : t);
const restMethod = (id: string) => /^rest:([A-Z]+) /.exec(id)?.[1];
/** Everything of a `rest:` entry except where it is: two entries equal under this are one route moved (§8.4). */
const moveKey = (t: DescribeTarget) => {
  const m = nativeDatabaseDefaults(t._meta);
  return m.behaviorHash === undefined || m.exposure === undefined
    ? undefined
    : canonical({
        method: restMethod(m.id),
        behaviorHash: m.behaviorHash,
        exposure: m.exposure,
        requires: m.requires,
        inputSchema: t.inputSchema,
        surfaces: m.surfaces,
        scope: m.scope,
        restrict: m.restrict,
        variants: m.variants,
        flags: securityFlags.map(f => m[f]),
      });
};
/** Pair each `rest:` entry that disappeared with one that appeared and differs from it only by its URI. */
function uriMoves(old: Map<string, DescribeTarget>, next: Map<string, DescribeTarget>): Map<string, string> {
  const moves = new Map<string, string>(),
    gone = [...old.keys()].filter(id => !next.has(id) && restMethod(id)).sort(),
    added = [...next.keys()].filter(id => !old.has(id) && restMethod(id)).sort();
  for (const from of gone) {
    const key = moveKey(old.get(from)!);
    const to = key && added.find(id => !moves.has(id) && moveKey(next.get(id)!) === key);
    if (to) moves.set(to, from);
  }
  return moves;
}
/** Report widening on any reachable surface or dispatcher variant. */
export function diffApp(a: AppDescription, b: AppDescription): AppChange[] {
  if (a.schemaVersion !== 1 || b.schemaVersion !== 1) throw new TypeError("Unsupported describe schemaVersion.");
  const changes: AppChange[] = [],
    old = new Map(a.targets.map(t => [t._meta.id, t])),
    next = new Map(b.targets.map(t => [t._meta.id, t]));
  const formulaA = a.targetHashVersion ?? 1,
    formulaB = b.targetHashVersion ?? 1,
    crossFormula = formulaA !== formulaB;
  if (crossFormula)
    changes.push({
      id: "*",
      field: "targetHashVersion",
      direction: "changed",
      before: formulaA,
      after: formulaB,
    });
  // Formula 1's value on either side: a formula-1 report's pin, or a later report's transition field.
  const formulaV1 = (m: DescribeTarget["_meta"], formula: number) => (formula === 1 ? m.targetHash : m.targetHashV1);
  const moves = uriMoves(old, next),
    moved = new Set(moves.values());
  for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    if (moved.has(id)) continue;
    const from = moves.get(id);
    if (from) {
      changes.push({
        id,
        field: "exposure",
        direction: "changed",
        before: from,
        after: id,
      });
      continue;
    }
    const before = old.get(id),
      after = next.get(id);
    if (!before || !after) {
      changes.push({
        id,
        field: "target",
        direction: before ? "narrowed" : "widened",
      });
      continue;
    }
    const x = nativeDatabaseDefaults(before._meta),
      y = nativeDatabaseDefaults(after._meta),
      start = changes.length;
    const record = (field: string, left: unknown, right: unknown, direction: Direction) => {
      if (canonical(left) !== canonical(right)) changes.push({ id, field, direction, before: left, after: right });
    };
    record("scope", x.scope, y.scope, policyDirection(x.scope, y.scope, true));
    record("restrict", x.restrict, y.restrict, policyDirection(x.restrict, y.restrict, false));
    record("requires", x.requires, y.requires, requiresDirection(x.requires, y.requires));
    record("surfaces", x.surfaces, y.surfaces, exposureDirection(x.surfaces.map(canonical), y.surfaces.map(canonical)));
    record(
      "triggers",
      x.triggers,
      y.triggers,
      exposureDirection(x.triggers.map(triggerKey), y.triggers.map(triggerKey)),
    );
    for (const field of securityFlags) record(field, x[field], y[field], flagDirection(field, y[field]));
    record("inputSchema", before.inputSchema, after.inputSchema, "changed");
    const directions: Direction[] = [];
    const variants = new Map(x.variants.map(v => [v.id, v])),
      added = new Map(y.variants.map(v => [v.id, v]));
    for (const name of new Set([...variants.keys(), ...added.keys()])) {
      const left = variants.get(name),
        right = added.get(name);
      if (canonical(left) === canonical(right)) continue;
      if (!left || !right) directions.push(left ? "narrowed" : "widened");
      else {
        if (canonical(left.scope) !== canonical(right.scope))
          directions.push(policyDirection(left.scope, right.scope, true));
        if (canonical(left.restrict) !== canonical(right.restrict))
          directions.push(policyDirection(left.restrict, right.restrict, false));
        if (canonical(left.requires) !== canonical(right.requires))
          directions.push(requiresDirection(left.requires, right.requires));
        if (canonical(left.inputSchema) !== canonical(right.inputSchema)) directions.push("changed");
        for (const field of securityFlags)
          if (left[field] !== right[field]) directions.push(flagDirection(field, right[field]));
      }
    }
    record("variants", x.variants, y.variants, combine(directions));
    if (x.exposure !== undefined && y.exposure !== undefined) record("exposure", x.exposure, y.exposure, "changed");
    if (x.behaviorHash !== undefined && y.behaviorHash !== undefined && x.behaviorHash !== y.behaviorHash)
      changes.push({ id, field: "behavior", direction: "changed" });
    else if (crossFormula) {
      // Across the formula change formula 1 is compared whatever else was recorded, so a SQL change is never hidden.
      const left = formulaV1(x, formulaA),
        right = formulaV1(y, formulaB);
      if (left === undefined || right === undefined)
        changes.push({
          id,
          field: "behavior",
          direction: "changed",
          unverified: true,
        });
      else if (left !== right) changes.push({ id, field: "behavior", direction: "changed" });
    }
    if (crossFormula || changes.length > start) continue;
    if (x.exposureHash !== undefined && y.exposureHash !== undefined && x.exposureHash !== y.exposureHash)
      changes.push({ id, field: "exposure", direction: "changed" });
    else if (x.targetHash !== y.targetHash) changes.push({ id, field: "behavior", direction: "changed" });
  }
  return changes;
}
