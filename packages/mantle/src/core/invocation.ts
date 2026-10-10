/** Invocation, the handler contract and the lifecycle port (ADR-0032 decisions 3 and 7, ADR-0034 decision 4). */
import type { LifecycleHook } from "../spec/domain/index.js";
import type { Caller } from "./caller.js";
import type { CallerStore, StoreRow } from "./store.js";

/** `ctx.cause.parent` chains through hooks and `ctx.invoke`; deeper than this fails `INVOCATION_DEPTH_EXCEEDED`. */
export const MAX_INVOCATION_DEPTH = 8;

/** Why a Procedure runs. `id` is stable across retries and deferred replays. */
export type InvocationCause = { readonly id: string; readonly parent?: InvocationCause } & (
  | { readonly kind: "http" | "mcp" | "internal" }
  | { readonly kind: "schedule"; readonly trigger: string; readonly cron: string; readonly scheduledTime: number }
  | {
      readonly kind: "lifecycle";
      readonly trigger: string;
      readonly hook: LifecycleHook;
      readonly schema: string;
      /** After hooks: every row the statement wrote, whole and as Store's `select` returns it, whatever its own RETURNING. Before hooks: the one row, or for an insert the row about to be written. */
      readonly rows: readonly [StoreRow, ...StoreRow[]];
    }
);

/** The serializable part of a call. Every source produces one; only an Invocation crosses a wire. */
export interface Invocation {
  readonly procedure: string;
  readonly input: unknown;
  readonly caller: Caller;
  readonly cause: InvocationCause;
}

/**
 * Handed to every handler. Authorization guards cannot write or invoke. Before hooks
 * use the normal caller-bound capabilities; their business logic and side effects belong to the application.
 */
export interface HandlerContext<Env = unknown, S extends { readonly db: object } = CallerStore> {
  readonly caller: Caller;
  readonly cause: InvocationCause;
  readonly env: Env;
  waitUntil(promise: Promise<unknown>): void;
  readonly store: S;
  /** The Store's schema readers (ADR-0043): `ctx.db === ctx.store.db`. */
  readonly db: S["db"];
  /** The one Procedure-to-Procedure entry: keeps the caller, chains `cause.parent`, re-runs the target's auth and guard. */
  invoke(procedure: string, input: unknown): Promise<unknown>;
}

/** `input` is validated against the Procedure's `input` schema before the call, the return against `output`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerFn<I = unknown, O = unknown, Env = unknown, S extends { readonly db: object } = CallerStore> = (input: I, ctx: HandlerContext<Env, S>) => O | Promise<O>;

/** Codegen narrows this to exactly the plan's refs (`HANDLER_NOT_REGISTERED` / `HANDLER_NOT_DECLARED`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MantleHandlers<Env = unknown> = Readonly<Record<string, HandlerFn<any, any, Env, any>>>;

/** One hook call: one statement and one Trigger. */
export interface LifecycleEvent {
  readonly id: string;
  readonly schema: string;
  readonly hook: LifecycleHook;
  readonly rows: readonly [StoreRow, ...StoreRow[]];
  readonly caller: Caller;
  readonly parent?: InvocationCause;
}

/** What Store calls; the Trigger layer implements it. Store never references Procedures. */
export interface LifecycleDispatcher {
  /** Runs before the batch applies, in op order. A throw rejects the mutation and applies nothing. */
  before(events: readonly LifecycleEvent[]): Promise<void>;
  /** Runs after a successful commit, best effort: a failure never changes the committed result. */
  after(events: readonly LifecycleEvent[]): Promise<void>;
}
