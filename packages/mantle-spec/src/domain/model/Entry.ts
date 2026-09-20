import type { ContentState } from "./ContentState.js";

export interface Entry {
  readonly id: string;
  readonly collection: string;
  /** Per-row locale, lifted from `data.locale` for ergonomic access.
   *  `undefined` when the source Schema is not localized
   *  (`Schema.spec.localized !== true`). Equivalent to
   *  `entry.data.locale` when set; the entry storage layer is the
   *  source of truth. */
  readonly locale?: string;
  readonly status: ContentState;
  /** Optimistic-locking version. Increments on every persisted update. */
  readonly version: number;
  readonly data: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Lifecycle-agnostic state-transition error. Thrown by `mantle-runtime`'s
 * dispatcher / entry-writer when a request would violate the transition
 * table; spec defines the type, runtime is the only thrower.
 */
export class IllegalTransitionError extends Error {
  constructor(public readonly from: ContentState, public readonly to: ContentState) {
    super(`illegal state transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}
