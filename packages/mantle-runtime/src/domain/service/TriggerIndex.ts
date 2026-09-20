import type { LifecycleHook, TriggerManifest } from "@aotter/mantle-spec";
import type {
  LifecycleHookPlan,
  RuntimeTriggerPlan,
} from "./RuntimePlanCompiler.js";

/**
 * Pre-built `(schema, hook) → Trigger[]` index for the lifecycle hook
 * runner. Built once at boot from the parsed manifest set; the
 * `LifecycleHookingEntryRepository` decorator queries it on every
 * mutation.
 *
 * Within a `(schema, hook)` group, Triggers fire in **alphabetical
 * order by `Trigger.metadata.name`**. Authors choose names that sort
 * correctly (`010-bot-check`, `020-rate-limit`).
 *
 * Pure data-structure — no I/O, no manifest validation. Lives in
 * `domain/service/`.
 */
export class TriggerIndex {
  private readonly bySchemaAndHook: Map<string, Map<LifecycleHook, TriggerManifest[]>>;

  constructor(triggers: readonly TriggerManifest[]) {
    this.bySchemaAndHook = new Map();
    for (const t of triggers) {
      if (t.spec.source.kind !== "lifecycle") continue;
      const schema = t.spec.source.schema;
      let inner = this.bySchemaAndHook.get(schema);
      if (!inner) {
        inner = new Map();
        this.bySchemaAndHook.set(schema, inner);
      }
      for (const hook of t.spec.source.on) {
        const list = inner.get(hook) ?? [];
        list.push(t);
        inner.set(hook, list);
      }
    }
    for (const inner of this.bySchemaAndHook.values()) {
      for (const list of inner.values()) {
        list.sort((a, b) =>
          a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0
        );
      }
    }
  }

  /** Runtime acceleration over the compiler-owned value index. */
  static fromPlan(
    groups: readonly LifecycleHookPlan[],
    triggers: Readonly<Record<string, RuntimeTriggerPlan>>,
  ): TriggerIndex {
    const index = new TriggerIndex([]);
    for (const group of groups) {
      let inner = index.bySchemaAndHook.get(group.schema);
      if (!inner) {
        inner = new Map();
        index.bySchemaAndHook.set(group.schema, inner);
      }
      inner.set(group.hook, group.triggerNames.map((name) => triggers[name]!.manifest));
    }
    return index;
  }

  /** Triggers bound to (schema, hook), in firing order. Empty array
   *  when nothing matches — callers don't need a null check. */
  forHook(schema: string, hook: LifecycleHook): readonly TriggerManifest[] {
    return this.bySchemaAndHook.get(schema)?.get(hook) ?? [];
  }
}
