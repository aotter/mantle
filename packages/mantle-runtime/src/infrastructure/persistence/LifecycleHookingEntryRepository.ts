import type { LifecycleHook } from "@aotter/mantle-spec";
import type { EntryRow } from "../../domain/model/EntryRow.js";
import type { HandlerContext } from "../../domain/model/HandlerContext.js";
import {
  DEFERRED_HOOK_ENVELOPE_VERSION,
  ctxSnapshotFrom,
  type DeferredHookDispatcher,
  type DeferredHookEnvelope,
  type DeferredLifecycleHook,
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
import type { IdGenerator } from "../../domain/port/IdGenerator.js";
import type { TriggerIndex } from "../../domain/service/TriggerIndex.js";
import type { RunLifecycleHooksUseCase } from "../../usecase/lifecycle/RunLifecycleHooksUseCase.js";

const ANON_CTX: HandlerContext = { user: null, staff: null, env: {} };

/** Shared mutation chokepoint for lifecycle Triggers. */
export class LifecycleHookingEntryRepository implements EntryRepository {
  constructor(
    private readonly inner: EntryRepository,
    private readonly triggers: TriggerIndex,
    private readonly hooks: Pick<RunLifecycleHooksUseCase, "run">,
    private readonly idgen: IdGenerator,
    private readonly deferred?: DeferredHookDispatcher,
  ) {}

  async create(args: CreateEntryArgs): Promise<EntryRow> {
    const before = this.triggerNames(args.collection, "before_create");
    const after = this.triggerNames(args.collection, "after_create");
    if (before.length === 0 && after.length === 0) return this.inner.create(args);

    const ctx = ctxOf(args);
    const beforeId = before.length > 0 ? this.idgen.next() : undefined;
    const afterId = after.length > 0 ? this.idgen.next() : undefined;
    await this.fireBefore("before_create", args.collection, null, ctx, args, before, beforeId);
    const row = await this.inner.create(args);
    await this.fireAfter("after_create", row, ctx, after, afterId);
    return row;
  }

  get(id: string): Promise<EntryRow | null> {
    return this.inner.get(id);
  }

  async update(args: UpdateEntryArgs): Promise<EntryRow> {
    const before = this.triggerNames(args.collection, "before_update");
    const after = this.triggerNames(args.collection, "after_update");
    if (before.length === 0 && after.length === 0) return this.inner.update(args);

    const existing = await this.inner.get(args.id);
    if (!existing) return this.inner.update(args);
    const ctx = ctxOf(args);
    const beforeId = before.length > 0 ? this.idgen.next() : undefined;
    const afterId = after.length > 0 ? this.idgen.next() : undefined;
    await this.fireBefore("before_update", args.collection, existing, ctx, args, before, beforeId);
    const row = await this.inner.update(args);
    await this.fireAfter("after_update", row, ctx, after, afterId);
    return row;
  }

  async delete(args: DeleteEntryArgs): Promise<{ readonly removed: boolean }> {
    const before = this.triggerNames(args.collection, "before_delete");
    const after = this.triggerNames(args.collection, "after_delete");
    if (before.length === 0 && after.length === 0) return this.inner.delete(args);

    const existing = await this.inner.get(args.id);
    if (!existing) return this.inner.delete(args);
    const ctx = ctxOf(args);
    const beforeId = before.length > 0 ? this.idgen.next() : undefined;
    const afterId = after.length > 0 ? this.idgen.next() : undefined;
    await this.fireBefore("before_delete", args.collection, existing, ctx, args, before, beforeId);
    const result = await this.inner.delete(args);
    if (result.removed) await this.fireAfter("after_delete", existing, ctx, after, afterId);
    return result;
  }

  async transitionStatus(args: TransitionStatusArgs): Promise<EntryRow> {
    const isPublish = args.to === "published";
    const beforeHook: LifecycleHook = isPublish ? "before_publish" : "before_update";
    const afterHook: DeferredLifecycleHook = isPublish ? "after_publish" : "after_update";
    const before = this.triggerNames(args.collection, beforeHook);
    const after = this.triggerNames(args.collection, afterHook);
    if (before.length === 0 && after.length === 0) return this.inner.transitionStatus(args);

    const existing = await this.inner.get(args.id);
    if (!existing) return this.inner.transitionStatus(args);
    const ctx = ctxOf(args);
    const beforeId = before.length > 0 ? this.idgen.next() : undefined;
    const afterId = after.length > 0 ? this.idgen.next() : undefined;
    await this.fireBefore(beforeHook, args.collection, existing, ctx, args, before, beforeId);
    const row = await this.inner.transitionStatus(args);
    await this.fireAfter(afterHook, row, ctx, after, afterId);
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

  private triggerNames(schema: string, hook: LifecycleHook): readonly string[] {
    return this.triggers.forHook(schema, hook).map((trigger) => trigger.metadata.name);
  }

  private async fireBefore(
    hook: LifecycleHook,
    schema: string,
    entry: EntryRow | null,
    ctx: HandlerContext,
    args: MutationHookFields,
    triggerNames: readonly string[],
    eventId: string | undefined,
  ): Promise<void> {
    if (eventId === undefined) return;
    await this.hooks.run({
      eventId,
      triggerNames,
      delivery: "inline",
      hook,
      schema,
      entry,
      ctx,
      originalInput: args.originalInput,
    });
  }

  /**
   * Queue acceptance is not atomic with the completed entry write.
   * On a definite or ambiguous enqueue rejection, reuse the same
   * event id in the best-effort waitUntil/inline fallback.
   */
  private async fireAfter(
    hook: DeferredLifecycleHook,
    entry: EntryRow,
    ctx: HandlerContext,
    triggerNames: readonly string[],
    eventId: string | undefined,
  ): Promise<void> {
    if (eventId === undefined) return;
    if (this.deferred) {
      const envelope: DeferredHookEnvelope = {
        version: DEFERRED_HOOK_ENVELOPE_VERSION,
        eventId,
        triggerNames,
        hook,
        schema: entry.collection,
        entry,
        ctxSnapshot: ctxSnapshotFrom(ctx),
      };
      try {
        await this.deferred.enqueue(envelope);
        return;
      } catch (error) {
        console.error("[lifecycle] deferred enqueue failed; using best-effort fallback", {
          eventId,
          hook,
          schema: entry.collection,
          entryId: entry.id,
          error,
        });
      }
    }

    const promise = this.hooks.run({
      eventId,
      triggerNames,
      delivery: "inline",
      hook,
      schema: entry.collection,
      entry,
      ctx,
    }).catch((error) => {
      console.error("[lifecycle] after-hook fallback failed", {
        eventId,
        hook,
        schema: entry.collection,
        entryId: entry.id,
        error,
      });
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
