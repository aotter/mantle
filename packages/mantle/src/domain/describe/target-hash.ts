import type { RuntimePlan } from "../../build/compiler.js";
import type { TargetDefinition } from "./targets.js";

import { canonical } from "../../build/spec/domain/service/PlanFingerprint.js";
export { canonical };

/** The `targetHash` formula describe reports; a report without `targetHashVersion` used formula 1. */
export const TARGET_HASH_VERSION = 2;

export async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Effective requirements: an admin surface implies the admin gate. */
export function requirements(
  d: TargetDefinition,
  surface: string,
): { all: readonly (string | { readonly "ctx.auth.scope": string })[] } {
  const all = d.requires?.auth?.all ?? [];
  return { all: surface === "admin" && !all.includes("ctx.admin") ? ["ctx.admin", ...all] : all };
}

/**
 * Formula 1 (before ADR-0047), frozen: describe reports it as `_meta.targetHashV1` through the 0.2.x line so a diff
 * across the formula change still compares like with like. Do not change it.
 */
export function targetHashV1(plan: RuntimePlan, d: TargetDefinition): Promise<string> {
  return hash({
    id: d.id,
    surfaces: d.surfaces,
    triggers: d.triggers,
    behavior: d.behavior,
    input: d.inputSchema,
    requires: d.requires,
    restrict: d.restrict,
    dialect: plan.dialect,
    schemas: Object.fromEntries(d.schemas.map(name => [name, plan.schemas[name]])),
    userFields: plan.access?.userFields,
    readOnly: d.readOnly,
    opaque: d.opaque,
    ...(d.nativeDatabase ? { nativeDatabase: true } : {}),
    trustedOnly: d.trustedOnly,
  });
}

export interface Fingerprints {
  /** What the operation does (ADR-0047 §7). */
  behaviorHash: string;
  /** Where and how it is reachable, presentation included. */
  exposureHash: string;
  /** The runtime pin: `hash({ behavior, exposure })`. */
  targetHash: string;
  targetHashV1: string;
}

/** The behavior payload of a target with behavior of its own; presentation is already out of `ownBehavior`. */
const behaviorPayload = (plan: RuntimePlan, d: TargetDefinition) => ({
  id: d.id,
  behavior: d.ownBehavior,
  requires: requirements(d, d.surface),
  restrict: d.restrict,
  dialect: plan.dialect,
  schemas: Object.fromEntries(d.schemas.map(name => [name, plan.schemas[name]])),
  userFields: plan.access?.userFields,
  readOnly: d.readOnly,
  opaque: d.opaque,
  ...(d.nativeDatabase ? { nativeDatabase: true } : {}),
  trustedOnly: d.trustedOnly,
});

/**
 * The declared presentation fields stay whole under `declared`: the resolved `title`/`description` below are English
 * only, so spreading them over the declaration would drop every other locale from the pin.
 */
const presentation = (d: TargetDefinition) => ({
  declared: d.presentation,
  title: d.title,
  description: d.description,
  annotations: d.annotations,
  toolMeta: d.toolMeta,
});

/** The exposure payload: a declaration's reachability other than its http Triggers, or a route's binding. */
const exposurePayload = (d: TargetDefinition) =>
  d.canonical
    ? {
        id: d.id,
        name: d.name,
        surfaces: d.surfaces.filter(s => s !== "rest"),
        triggers: d.triggers.filter(t => t.source.kind !== "http"),
        inputSchema: d.inputSchema,
        requires: requirements(d, d.surface),
        readOnly: d.readOnly,
        trustedOnly: d.trustedOnly,
        presentation: presentation(d),
      }
    : {
        id: d.id,
        name: d.name,
        exposure: d.binding,
        inputSchema: d.inputSchema,
        requires: requirements(d, d.surface),
        readOnly: d.readOnly,
        trustedOnly: d.trustedOnly,
        variants: d.variants.map(v => v.id),
        presentation: presentation(d),
      };

/** Fingerprints for every definition; a variant's behaviorHash is computed once and shared with its routes. */
export function fingerprinter(plan: RuntimePlan): (d: TargetDefinition) => Promise<Fingerprints> {
  const behaviors = new Map<TargetDefinition, Promise<string>>();
  const behaviorHash = (d: TargetDefinition): Promise<string> => {
    let h = behaviors.get(d);
    if (!h) {
      h =
        d.ownBehavior === undefined && d.variants.length === 1
          ? behaviorHash(d.variants[0]!)
          : d.variants.length === 0
            ? hash(behaviorPayload(plan, d))
            : Promise.all(d.variants.map(async v => [v.id, await behaviorHash(v)])).then(variants =>
                hash({ own: behaviorPayload(plan, d), variants }),
              );
      behaviors.set(d, h);
    }
    return h;
  };
  return async d => {
    const [behavior, exposure, v1] = await Promise.all([
      behaviorHash(d),
      hash(exposurePayload(d)),
      targetHashV1(plan, d),
    ]);
    return {
      behaviorHash: behavior,
      exposureHash: exposure,
      targetHash: await hash({ behavior, exposure }),
      targetHashV1: v1,
    };
  };
}
