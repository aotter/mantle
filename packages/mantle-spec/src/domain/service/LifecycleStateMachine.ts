import type { ContentState } from "../model/ContentState.js";
import type { LifecycleMode } from "../model/ManifestGrammar.js";

/**
 * Per-Schema lifecycle state machine. Each Schema declares
 * `spec.lifecycle: 'publishing' | 'editorial' | 'operational'` (default
 * `'publishing'`); this
 * module translates that into allowed state transitions and tells callers
 * whether a publish request would require the deferred editorial approval
 * runtime or can publish directly.
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
  };
}

const DEFAULT_LIFECYCLE: LifecycleMode = "publishing";

export function resolveLifecycle(schema: LifecycleSchemaLike | undefined): LifecycleMode {
  return schema?.spec.lifecycle ?? DEFAULT_LIFECYCLE;
}

/**
 * Whether `requestPublish` would require editorial approval rather than the
 * shipped direct publishing transition. Current `RequestPublishUseCase` rejects
 * when this returns true; it does not write an approval row yet.
 */
export function publishRequiresApproval(schema: LifecycleSchemaLike | undefined): boolean {
  return resolveLifecycle(schema) === "editorial";
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
 *
 * Editorial lifecycle:
 *   draft → review, draft → archived
 *   review → approved, review → draft (rejected)
 *   approved → scheduled, approved → published
 *   scheduled → published, scheduled → draft
 *   published → archived, published → draft
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
  review: new Set(),
  approved: new Set(),
  scheduled: new Set(),
  published: new Set<ContentState>(["archived", "draft"]),
  archived: new Set<ContentState>(["draft"]),
};

const EDITORIAL_TRANSITIONS: Readonly<Record<ContentState, ReadonlySet<ContentState>>> = {
  draft: new Set<ContentState>(["review", "archived"]),
  review: new Set<ContentState>(["approved", "draft"]),
  approved: new Set<ContentState>(["scheduled", "published"]),
  scheduled: new Set<ContentState>(["published", "draft"]),
  published: new Set<ContentState>(["archived", "draft"]),
  archived: new Set<ContentState>(["draft"]),
};

/** `lifecycle: operational` — orders, snapshots, audit
 *  rows). No content workflow: entries are live on creation, editable
 *  in place, and never publish/unpublish/archive. */
const OPERATIONAL_TRANSITIONS: Readonly<Record<ContentState, ReadonlySet<ContentState>>> = {
  draft: new Set(),
  review: new Set(),
  approved: new Set(),
  scheduled: new Set(),
  published: new Set(),
  archived: new Set(),
};

function transitionsFor(mode: LifecycleMode): Readonly<Record<ContentState, ReadonlySet<ContentState>>> {
  if (mode === "editorial") return EDITORIAL_TRANSITIONS;
  if (mode === "operational") return OPERATIONAL_TRANSITIONS;
  return PUBLISHING_TRANSITIONS;
}
