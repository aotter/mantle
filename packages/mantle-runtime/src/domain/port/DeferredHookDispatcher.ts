import type { LifecycleHook, StaffRole } from "@aotter/mantle-spec";
import type { EntryRow } from "../model/EntryRow.js";
import type { HandlerAuthContext, HandlerContext } from "../model/HandlerContext.js";

/**
 * Optional adapter port for delivering `after_*` lifecycle hooks
 * out-of-band — later, in a separate invocation, with durability
 * across isolate death. The adapter's consume-side handler rehydrates
 * the envelope and drives `CmsRuntime.runDeferredHook`. Absent a
 * dispatcher, the decorator's `fireAfter` ladder downgrades to
 * `ctx.waitUntil` then inline-await.
 *
 * Contract: a thrown rejection from `enqueue` is treated as a hard
 * delivery failure — the decorator catches it and downgrades to the
 * next rung. Adapters should swallow transient errors they can
 * tolerate themselves; only escalate when the hook genuinely cannot
 * be deferred.
 */
export interface DeferredHookDispatcher {
  enqueue(envelope: DeferredHookEnvelope): Promise<void>;
}

/**
 * Wire envelope for a deferred `after_*` lifecycle hook. Carries
 * everything the consume side needs to reconstruct the original
 * `RunLifecycleHookRequest` without re-reading the database.
 *
 * `entry` is the row at fire time — for `after_delete` the row is
 * already gone from the DB, so the envelope must carry it. For other
 * `after_*` hooks the row also matches what the in-process firing path
 * would have seen, avoiding read-skew with subsequent mutations.
 *
 * `ctxSnapshot` carries enough identity to rebuild a `HandlerContext`
 * with the original actor's user/staff fields. `waitUntil` is dropped —
 * the consume invocation owns its own request lifetime — and `env` is
 * filled from the consume-side adapter binding.
 */
export interface DeferredHookEnvelope {
  readonly hook: LifecycleHook;
  readonly schema: string;
  readonly entry: EntryRow;
  readonly originalInput?: unknown;
  readonly ctxSnapshot: CtxSnapshot | null;
}

export interface CtxSnapshot {
  readonly userId: string | null;
  readonly staffId: string | null;
  readonly staffRole: StaffRole | null;
  /** Optional for backward compatibility with envelopes queued before
   *  credential context was introduced. */
  readonly auth?: HandlerAuthContext | null;
}

/**
 * Capture identity from a `HandlerContext` into the wire-friendly
 * `CtxSnapshot`. Returns `null` for fully anonymous contexts so the
 * envelope stays small. Lives next to `CtxSnapshot` so the producer
 * (decorator) and consumer (use case) share one source of truth.
 */
export function ctxSnapshotFrom(ctx: HandlerContext): CtxSnapshot | null {
  if (!ctx.user && !ctx.staff && !ctx.auth) return null;
  return {
    userId: ctx.user?.id ?? null,
    staffId: ctx.staff?.id ?? null,
    staffRole: ctx.staff?.role ?? null,
    ...(ctx.auth ? { auth: ctx.auth } : {}),
  };
}
