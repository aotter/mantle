import type { LifecycleHook, StaffRole } from "@aotter/mantle-spec";
import type { EntryRow } from "../model/EntryRow.js";
import type { HandlerAuthContext, HandlerContext } from "../model/HandlerContext.js";

/**
 * Optional adapter port for delivering `after_*` lifecycle hooks
 * out-of-band. A successful `enqueue` means only that the adapter
 * accepted the message; the entry mutation and enqueue do not share a
 * transaction. Consumption is at-least-once, so handlers must use
 * `eventId` + Trigger name as an idempotency key.
 *
 * Contract: a thrown rejection from `enqueue` is treated as a hard
 * delivery failure — the decorator catches it and downgrades to
 * best-effort `ctx.waitUntil`, then inline execution. An ambiguous
 * enqueue can therefore run both paths; both preserve the same event
 * identity.
 */
export interface DeferredHookDispatcher {
  enqueue(envelope: DeferredHookEnvelope): Promise<void>;
}

/**
 * Wire envelope for a deferred `after_*` lifecycle hook. Version 1
 * deliberately carries persisted entry data, not arbitrary request
 * input (which may contain credentials or exceed queue limits).
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
export const DEFERRED_HOOK_ENVELOPE_VERSION = 1 as const;

export type DeferredLifecycleHook = Extract<LifecycleHook, `after_${string}`>;

export interface DeferredHookEnvelope {
  readonly version: typeof DEFERRED_HOOK_ENVELOPE_VERSION;
  /** Stable across enqueue fallback, Queue retries, and replay. */
  readonly eventId: string;
  /** Captured at production time so a later deploy cannot add a new
   *  Trigger to an already-enqueued event. Ordered firing list. */
  readonly triggerNames: readonly string[];
  readonly hook: DeferredLifecycleHook;
  readonly schema: string;
  readonly entry: EntryRow;
  readonly ctxSnapshot: CtxSnapshot | null;
}

export interface CtxSnapshot {
  readonly userId: string | null;
  readonly staffId: string | null;
  readonly staffRole: StaffRole | null;
  readonly auth: HandlerAuthContext | null;
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
    auth: ctx.auth ?? null,
  };
}
