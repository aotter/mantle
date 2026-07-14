import type { LifecycleHook } from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import {
  ctxSnapshotFrom,
  type DeferredHookDispatcher,
  type DeferredHookEnvelope,
} from "../../domain/port/DeferredHookDispatcher.js";
import type {
  CreateEntryArgs,
  DeleteEntryArgs,
  EntryRepository,
  FindEntryByDataFieldArgs,
  FindEntryByDataFieldsArgs,
  ListEntriesArgs,
  ListEntriesResult,
  MutationHookFields,
  TransitionStatusArgs,
  UpdateEntryArgs,
} from "../../domain/port/EntryRepository.js";
import type { TriggerIndex } from "../../domain/service/TriggerIndex.js";
import type { RunLifecycleHooksUseCase } from "../../usecase/lifecycle/RunLifecycleHooksUseCase.js";

const ANON_CTX: HandlerContext = { user: null, staff: null, env: {} };

/**
 * Decorator that wraps any `EntryRepository` and fires lifecycle
 * Triggers around every mutation (POC ADR-0014).
 *
 * Symmetry rule: MCP, admin, and builtin write paths all hit the same
 * chokepoint, so all three pay (and gain) the same hook semantics —
 * authors don't need to remember "hooks fire on path X but not Y."
 *
 * Hook → mutation mapping:
 *   - `create` → `before_create` / `after_create`
 *   - `update` → `before_update` / `after_update`
 *   - `delete` → `before_delete` / `after_delete`
 *   - `transitionStatus({ to: 'published' })` → `before_publish` /
 *      `after_publish`; other targets fire `before_update` /
 *      `after_update`
 *
 * Short-circuits when no Trigger watches the row's collection — no
 * hook runner call, no per-mutation overhead.
 *
 * `before_*` runs synchronously: a thrown `DiagnosticError` from the
 * runner cancels the mutation. `after_*` runs after the inner write
 * succeeds — fire-and-forget via `ctx.waitUntil` if the adapter
 * populated it; otherwise inline-await.
 */
export class LifecycleHookingEntryRepository implements EntryRepository {
  constructor(
    private readonly inner: EntryRepository,
    private readonly triggers: TriggerIndex,
    private readonly hooks: Pick<RunLifecycleHooksUseCase, "run">,
    private readonly deferred?: DeferredHookDispatcher,
  ) {}

  async create(args: CreateEntryArgs): Promise<EntryRow> {
    const ctx = ctxOf(args);
    if (!this.triggers.hasAny(args.collection)) {
      return this.inner.create(args);
    }
    await this.hooks.run({
      hook: "before_create",
      schema: args.collection,
      entry: null,
      ctx,
      originalInput: args.originalInput,
    });
    const row = await this.inner.create(args);
    await this.fireAfter("after_create", row, ctx, args);
    return row;
  }

  get(id: string): Promise<EntryRow | null> {
    return this.inner.get(id);
  }

  async update(args: UpdateEntryArgs): Promise<EntryRow> {
    if (!this.triggers.hasAny(args.collection)) {
      return this.inner.update(args);
    }
    const existing = await this.inner.get(args.id);
    if (!existing) return this.inner.update(args);
    const ctx = ctxOf(args);
    await this.hooks.run({
      hook: "before_update",
      schema: args.collection,
      entry: existing,
      ctx,
      originalInput: args.originalInput,
    });
    const row = await this.inner.update(args);
    await this.fireAfter("after_update", row, ctx, args);
    return row;
  }

  async delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }> {
    if (!this.triggers.hasAny(args.collection)) {
      return this.inner.delete(args);
    }
    const existing = await this.inner.get(args.id);
    if (!existing) return this.inner.delete(args);
    const ctx = ctxOf(args);
    await this.hooks.run({
      hook: "before_delete",
      schema: args.collection,
      entry: existing,
      ctx,
      originalInput: args.originalInput,
    });
    const result = await this.inner.delete(args);
    if (result.removed) {
      await this.fireAfter("after_delete", existing, ctx, args);
    }
    return result;
  }

  async transitionStatus(args: TransitionStatusArgs): Promise<EntryRow> {
    if (!this.triggers.hasAny(args.collection)) {
      return this.inner.transitionStatus(args);
    }
    const isPublish = args.to === "published";
    const beforeHook: LifecycleHook = isPublish ? "before_publish" : "before_update";
    const afterHook: LifecycleHook = isPublish ? "after_publish" : "after_update";
    const existing = await this.inner.get(args.id);
    if (!existing) return this.inner.transitionStatus(args);
    const ctx = ctxOf(args);
    await this.hooks.run({
      hook: beforeHook,
      schema: args.collection,
      entry: existing,
      ctx,
      originalInput: args.originalInput,
    });
    const row = await this.inner.transitionStatus(args);
    await this.fireAfter(afterHook, row, ctx, args);
    return row;
  }

  list(args: ListEntriesArgs): Promise<ListEntriesResult> {
    return this.inner.list(args);
  }

  findByDataField(args: FindEntryByDataFieldArgs): Promise<EntryRow | null> {
    return this.inner.findByDataField(args);
  }

  findByDataFields(args: FindEntryByDataFieldsArgs): Promise<EntryRow | null> {
    return this.inner.findByDataFields(args);
  }

  /**
   * After-hook execution. Tries delivery rungs in order:
   *
   *   1. `deferred.enqueue(envelope)` — adapter-backed deferred path
   *      (CF Workers Queues, Inngest, pg-boss, …). Survives isolate
   *      death; consume invocation rehydrates the envelope and re-fires
   *      via `CmsRuntime.runDeferredHook`. A rejection downgrades to
   *      the next rung rather than dropping the hook silently.
   *   2. `ctx.waitUntil(promise)` — adapter-populated fire-and-forget
   *      bridge (CF Workers `ExecutionContext`). Fast but non-durable:
   *      isolate death between response and resolution loses the work.
   *   3. inline `await promise` — non-Workers runtimes (Bun / Node /
   *      tests) where detached promises get cancelled with the request.
   *      Trades response latency for hook-fire reliability.
   *
   * Hook throws are surfaced via `RunLifecycleHooksUseCase`'s
   * `errorPolicy` semantics; for `continue` the runner already
   * `console.error`s and swallows. Anything that escapes the inline
   * branch here is an abort-policy throw on a before_* (impossible —
   * the parser rejects `errorPolicy: abort` on after_* hooks) or an
   * unexpected internal error; we log and swallow so the mutation
   * result still reaches the caller.
   */
  private async fireAfter(
    hook: LifecycleHook,
    entry: EntryRow,
    ctx: HandlerContext,
    args: MutationHookFields,
  ): Promise<void> {
    if (this.deferred && this.triggers.forHook(entry.collection, hook).length > 0) {
      const envelope: DeferredHookEnvelope = {
        hook,
        schema: entry.collection,
        entry,
        originalInput: args.originalInput,
        ctxSnapshot: ctxSnapshotFrom(ctx),
      };
      try {
        await this.deferred.enqueue(envelope);
        return;
      } catch (err) {
        console.error(
          `[lifecycle] deferred enqueue for ${hook} on ${entry.collection}/${entry.id} failed; falling back`,
          err,
        );
      }
    }
    const promise = this.hooks.run({
      hook,
      schema: entry.collection,
      entry,
      ctx,
      originalInput: args.originalInput,
    }).catch((err) => {
      console.error(`[lifecycle] ${hook} on ${entry.collection}/${entry.id} failed`, err);
    });
    if (ctx.waitUntil) {
      ctx.waitUntil(promise);
      return;
    }
    await promise;
  }
}

function ctxOf(args: MutationHookFields): HandlerContext {
  return args.hookContext ?? ANON_CTX;
}
