import type { LifecycleHook, TriggerManifest } from "@aotter/mantle-spec";

/**
 * Pre-built `(schema, hook) → Trigger[]` index for the lifecycle hook
 * runner. Built once at boot from the parsed manifest set; the
 * `LifecycleHookingEntryRepository` decorator queries it on every
 * mutation.
 *
 * Within a `(schema, hook)` group, Triggers fire in **alphabetical
 * order by `Trigger.metadata.name`** — a `priority: number` key is
 * reserved for v0.2 (POC ADR-0014). Authors choose names that sort
 * correctly today (`010-bot-check`, `020-rate-limit`).
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
        list.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
      }
    }
  }

  /** Triggers bound to (schema, hook), in firing order. Empty array
   *  when nothing matches — callers don't need a null check. */
  forHook(schema: string, hook: LifecycleHook): readonly TriggerManifest[] {
    return this.bySchemaAndHook.get(schema)?.get(hook) ?? [];
  }
}
