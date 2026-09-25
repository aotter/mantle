import type { ViewRowAction } from "@aotter/mantle-runtime";
import type { Diagnostic } from "@aotter/mantle-spec";

/**
 * Framework-free interaction logic (ADR-0029 D7): one operation opened from
 * one row, reviewed by a person, submitted once. The host injects `read` and
 * `invoke` — the Admin's staff MCP client, an MCP App's `callServerTool`, or
 * an application's own HTTP client — and renders the snapshot however it
 * likes. Nothing here touches a router, cookies, globals or a UI framework.
 */

/** An entry as a person reviews it; its `version` is what a submit locks. */
export interface EntrySnapshot {
  readonly id: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The operation's answer. Business failures carry runtime diagnostics. */
export type InvokeOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface InteractionControllerOptions {
  /** The row action being opened, as a View capability lists it. */
  readonly interaction: Pick<ViewRowAction, "bind" | "version">;
  /** The row as the person saw it in the list. */
  readonly row?: Readonly<Record<string, unknown>>;
  /** A fresh read of the operation target (for example `read_entry`). */
  readonly read?: (signal: AbortSignal) => Promise<EntrySnapshot>;
  /** Invoke the operation once. A throw or abort means the outcome is unknown. */
  readonly invoke: (input: Record<string, unknown>, signal: AbortSignal) => Promise<InvokeOutcome>;
  /** Editable inputs to start from. */
  readonly initialInput?: Readonly<Record<string, unknown>>;
}

export type InteractionPhase =
  /** Not opened yet. */
  | "idle"
  /** Reading the target to confirm what the person reviews. */
  | "loading"
  /** Ready to edit and submit. */
  | "ready"
  /** A read found a newer version than the one reviewed; `review()` adopts it. */
  | "changedSinceList"
  | "submitting"
  | "succeeded"
  /** The operation refused; `diagnostics` say why, and the input is kept. */
  | "failed"
  /** The reviewed version is no longer current; `reread()`, then review again. */
  | "conflict"
  /** The write may or may not have happened; `reread()` before anything else. */
  | "uncertain"
  | "cancelled";

export interface InteractionState {
  readonly phase: InteractionPhase;
  /** Inputs taken from the row; not editable. */
  readonly bound: Readonly<Record<string, unknown>>;
  /** Editable inputs, kept across refreshes, conflicts and failures. */
  readonly draft: Readonly<Record<string, unknown>>;
  readonly dirty: boolean;
  /** The entry the person is reviewing. */
  readonly reviewed: EntrySnapshot | null;
  /** A newer read that has not been reviewed yet. */
  readonly latest: EntrySnapshot | null;
  /** Runtime diagnostics from the last refusal. */
  readonly diagnostics: readonly Diagnostic[];
  /** A transport or read failure, as thrown. */
  readonly error: unknown;
  readonly result: unknown;
}

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface InteractionController {
  /** `useSyncExternalStore`-compatible subscription. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): InteractionState;
  /** Confirm the target: reads it when the operation locks a version. */
  open(): Promise<void>;
  /** Change one editable input. Bound inputs and the version are not editable. */
  edit(field: string, value: unknown): void;
  /** Background re-read. Never replaces the reviewed entry or the draft. */
  refresh(): Promise<void>;
  /** Adopt the newer read as the reviewed entry. */
  review(): void;
  /** After a conflict or an uncertain write: read again, then review. */
  reread(): Promise<void>;
  /** Submit once with the reviewed version. Never retried. */
  submit(): Promise<void>;
  /** Stop. An in-flight submit becomes `uncertain`, since it may have landed. */
  cancel(): void;
  /** Draft inputs that differ from the reviewed entry's fields. */
  changes(): readonly FieldChange[];
}

const EDITABLE: ReadonlySet<InteractionPhase> = new Set(["ready", "changedSinceList", "failed", "conflict", "uncertain"]);
const SUBMITTABLE: ReadonlySet<InteractionPhase> = new Set(["ready", "failed"]);
const REREADABLE: ReadonlySet<InteractionPhase> = new Set(["changedSinceList", "failed", "conflict", "uncertain"]);

export function createInteractionController(options: InteractionControllerOptions): InteractionController {
  const { interaction, row, read, invoke } = options;
  const versionInput = interaction.version;
  const bound = Object.freeze(Object.fromEntries(interaction.bind.map(({ input, field }) => [input, row?.[field]])));
  const listSnapshot = row && typeof row["id"] === "string" && typeof row["version"] === "number"
    ? Object.freeze({ id: row["id"], version: row["version"], data: row })
    : null;

  let state: InteractionState = Object.freeze({
    phase: "idle",
    bound,
    draft: Object.freeze({ ...options.initialInput }),
    dirty: false,
    reviewed: listSnapshot,
    latest: null,
    diagnostics: [],
    error: undefined,
    result: undefined,
  });
  const listeners = new Set<() => void>();
  // Each read or submit owns one abort controller; a newer step or a cancel
  // makes an older answer stale, and stale answers are dropped.
  let current: AbortController | null = null;
  let step = 0;

  const set = (patch: Partial<InteractionState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  const begin = () => {
    current?.abort();
    current = new AbortController();
    return { id: ++step, signal: current.signal };
  };
  const stale = (id: number) => id !== step || state.phase === "cancelled";
  const locks = versionInput !== undefined;

  const readInto = async (onFresh: (fresh: EntrySnapshot) => Partial<InteractionState>) => {
    if (!read) return false;
    const { id, signal } = begin();
    try {
      const fresh = Object.freeze({ ...(await read(signal)) });
      if (!stale(id)) set({ ...onFresh(fresh), error: undefined });
    } catch (error) {
      if (!stale(id)) set({ phase: "failed", error });
    }
    return true;
  };
  /** A read either confirms the reviewed version or waits for a review. */
  const confirm = (fresh: EntrySnapshot): Partial<InteractionState> =>
    !state.reviewed || state.reviewed.version === fresh.version
      ? { phase: "ready", reviewed: fresh, latest: null }
      : { phase: "changedSinceList", latest: fresh };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,

    async open() {
      if (state.phase !== "idle") return;
      if (!locks || !read) {
        set({ phase: "ready" });
        return;
      }
      set({ phase: "loading" });
      await readInto(confirm);
    },

    edit(field, value) {
      if (!EDITABLE.has(state.phase)) return;
      if (field in bound || field === versionInput) {
        throw new TypeError(`Input '${field}' comes from the reviewed row and cannot be edited.`);
      }
      set({ draft: Object.freeze({ ...state.draft, [field]: value }), dirty: true });
    },

    async refresh() {
      if (!["ready", "changedSinceList", "failed"].includes(state.phase)) return;
      // A background read only records what changed; the person decides.
      await readInto((fresh) => state.reviewed && state.reviewed.version !== fresh.version
        ? { phase: "changedSinceList", latest: fresh }
        : { latest: null, ...(state.reviewed ? {} : { reviewed: fresh }) });
    },

    review() {
      if (state.phase !== "changedSinceList" || !state.latest) return;
      set({ phase: "ready", reviewed: state.latest, latest: null, diagnostics: [] });
    },

    async reread() {
      if (!REREADABLE.has(state.phase)) return;
      // With no way to read the target the person accepts the risk explicitly.
      if (!(await readInto(confirm))) set({ phase: "ready", error: undefined });
    },

    async submit() {
      if (!SUBMITTABLE.has(state.phase)) return;
      // A failed read leaves nothing confirmed to submit against.
      if (state.phase === "failed" && state.error !== undefined) return;
      if (locks && !state.reviewed) throw new TypeError("This operation needs a reviewed entry version before submitting.");
      const input = {
        ...state.draft,
        ...bound,
        ...(locks ? { [versionInput]: state.reviewed!.version } : {}),
      };
      const { id, signal } = begin();
      set({ phase: "submitting", diagnostics: [], error: undefined });
      let outcome: InvokeOutcome;
      try {
        outcome = await invoke(input, signal);
      } catch (error) {
        // Timeouts and dropped connections may still have written.
        if (id === step) set({ phase: "uncertain", error });
        return;
      }
      if (stale(id)) return;
      if (outcome.ok) {
        set({ phase: "succeeded", result: outcome.data, dirty: false });
        return;
      }
      const conflict = outcome.diagnostics.some((diagnostic) => diagnostic.code === "CONFLICT");
      set({ phase: conflict ? "conflict" : "failed", diagnostics: outcome.diagnostics });
    },

    cancel() {
      if (state.phase === "cancelled" || state.phase === "succeeded") return;
      const submitting = state.phase === "submitting";
      current?.abort();
      current = null;
      step++;
      set({ phase: submitting ? "uncertain" : "cancelled" });
    },

    changes() {
      const before = state.reviewed?.data ?? {};
      return Object.entries(state.draft)
        .filter(([field, value]) => JSON.stringify(before[field]) !== JSON.stringify(value))
        .map(([field, after]) => ({ field, before: before[field], after }));
    },
  };
}
