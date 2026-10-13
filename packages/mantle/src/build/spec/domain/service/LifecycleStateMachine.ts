import type { ContentState } from "../model/ContentState.js";
import type { LifecycleMode } from "../model/ManifestGrammar.js";

/**
 * Per-Schema lifecycle state machine. Each Schema declares
 * `spec.lifecycle: 'publishing' | 'operational'` (default `'publishing'`);
 * this module translates that into allowed state transitions.
 *
 * Pure functions — no env, no DB. Feeds the dispatcher's
 * requestPublish branching and runtime state-transition validation.
 */

/**
 * Structural shape of a Schema manifest as far as the state machine
 * cares — just `spec.lifecycle?`. The full `SchemaManifest` type
 * lives in `domain/model/ManifestGrammar.ts` and conforms to this
 * structurally, so callers can pass either one.
 */
export interface LifecycleSchemaLike {
  readonly spec: {
    readonly lifecycle?: LifecycleMode;
    /** Present when publishing an entry requires a published parent (ADR-0010). */
    readonly translates?: unknown;
  };
}

const DEFAULT_LIFECYCLE: LifecycleMode = "publishing";

export function resolveLifecycle(schema: LifecycleSchemaLike | undefined): LifecycleMode {
  return schema?.spec.lifecycle ?? DEFAULT_LIFECYCLE;
}

/** Publishing Schemas keep drafts, protect published entries and gate public reads. */
export function isPublishing(schema: LifecycleSchemaLike | undefined): boolean {
  return resolveLifecycle(schema) === "publishing";
}

/**
 * One row mutation as the lifecycle sees it. `to` is an explicitly
 * requested status (publish, unpublish, archive, restore); `data` says
 * whether the mutation also changes field values.
 */
export type LifecycleWrite =
  | { readonly op: "insert" }
  | { readonly op: "update"; readonly from: ContentState; readonly to?: ContentState; readonly data: boolean }
  | { readonly op: "delete"; readonly from: ContentState };

/**
 * `validate` is how much of the Schema the resulting data must satisfy:
 * drafts save incomplete (`partial`), live entries must be complete
 * (`full`), and a pure status change that is not a publish checks nothing.
 */
export type LifecycleDecision =
  | {
      readonly allowed: true;
      readonly status: ContentState;
      readonly validate: "partial" | "full" | "none";
      /** Publishing a translation requires its parent to be published first. */
      readonly publishedParent: boolean;
    }
  | { readonly allowed: false; readonly reason: "transition" | "not-editable" | "published-protected" };

/**
 * The single lifecycle rule set for every row write (ADR-0032 decision 1):
 * initial status, editability, transitions and published protection.
 * Pure; the caller performs the reads it asks for (`publishedParent`).
 */
export function decideLifecycleWrite(
  schema: LifecycleSchemaLike | undefined,
  write: LifecycleWrite,
): LifecycleDecision {
  const publishing = isPublishing(schema);
  if (write.op === "insert") {
    // Operational records have no publish step; they are live the moment they exist.
    return publishing
      ? { allowed: true, status: "draft", validate: "partial", publishedParent: false }
      : { allowed: true, status: "published", validate: "full", publishedParent: false };
  }
  if (write.op === "delete") {
    return publishing && write.from === "published"
      ? { allowed: false, reason: "published-protected" }
      : { allowed: true, status: write.from, validate: "none", publishedParent: false };
  }
  // An explicit status must be a legal transition, even when it equals the current one.
  if (write.to !== undefined && !canTransition(schema, write.from, write.to)) {
    return { allowed: false, reason: "transition" };
  }
  // Only drafts are editable on publishing Schemas; operational records edit in place.
  if (write.data && publishing && write.from !== "draft") {
    return { allowed: false, reason: "not-editable" };
  }
  const status = write.to ?? write.from;
  const publish = write.to === "published";
  return {
    allowed: true,
    status,
    validate: publish || (write.data && !publishing) ? "full" : write.data ? "partial" : "none",
    publishedParent: publish && schema?.spec.translates !== undefined,
  };
}

/**
 * Allowed status transitions per lifecycle. Used by the MCP handler
 * and admin endpoints to gate operations. Unknown transitions return
 * `false` and the caller should reject with `CONFLICT`.
 *
 * Publishing lifecycle:
 *   draft → published, draft → archived
 *   published → archived, published → draft (unpublish-as-edit)
 *   archived → draft
 */
export function canTransition(
  schema: LifecycleSchemaLike | undefined,
  from: ContentState,
  to: ContentState,
): boolean {
  const allowed = transitionsFor(resolveLifecycle(schema));
  return allowed[from]?.has(to) ?? false;
}

const PUBLISHING_TRANSITIONS: Readonly<Record<ContentState, ReadonlySet<ContentState>>> = {
  draft: new Set<ContentState>(["published", "archived"]),
  published: new Set<ContentState>(["archived", "draft"]),
  archived: new Set<ContentState>(["draft"]),
};

/** `lifecycle: operational` — orders, snapshots, audit
 *  rows). No content workflow: entries are live on creation, editable
 *  in place, and never publish/unpublish/archive. */
const OPERATIONAL_TRANSITIONS: Readonly<Record<ContentState, ReadonlySet<ContentState>>> = {
  draft: new Set(),
  published: new Set(),
  archived: new Set(),
};

function transitionsFor(mode: LifecycleMode): Readonly<Record<ContentState, ReadonlySet<ContentState>>> {
  if (mode === "operational") return OPERATIONAL_TRANSITIONS;
  return PUBLISHING_TRANSITIONS;
}
