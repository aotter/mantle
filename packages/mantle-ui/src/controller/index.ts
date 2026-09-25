/**
 * Framework-free interaction logic (ADR-0029 D7): one operation opened from
 * one row, reviewed by a person, submitted once. The host injects `read` and
 * `invoke` — the Admin's staff MCP client, an MCP App's `callServerTool`, or
 * an application's own HTTP client — and renders the snapshot however it
 * likes. Nothing here touches a router, cookies, globals or a UI framework,
 * and nothing is imported: the Mantle shapes below are structural, so a
 * runtime `ViewRowAction` and `Diagnostic` fit them as they are.
 */

/** How a row feeds the operation: a runtime `ViewRowAction` fits. */
export interface InteractionBinding {
  /** Operation inputs taken from the row: `input` ← row `field`. */
  readonly bind: readonly { readonly input: string; readonly field: string }[];
  /** Input that receives the reviewed entry's `version`, when the operation locks it. */
  readonly version?: string;
}

/** The runtime Diagnostic fields the controller reads. */
export interface InteractionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly failure?: { readonly outcome?: string; readonly retry?: string };
}

/** An entry as a person reviews it; its `version` is what a submit locks. */
export interface EntrySnapshot {
  readonly id: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The operation's answer. Business failures carry runtime diagnostics. */
export type InvokeOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly diagnostics: readonly InteractionDiagnostic[] };

export interface InteractionControllerOptions {
  /** The row action being opened, as a View capability lists it. */
  readonly interaction: InteractionBinding;
  /** The row as the person saw it in the list. */
  readonly row?: Readonly<Record<string, unknown>>;
  /** A fresh read of the operation target (for example `read_entry`). */
  readonly read?: (signal: AbortSignal) => Promise<EntrySnapshot>;
  /** Invoke the operation once. A throw or abort means the outcome is unknown. */
  readonly invoke: (input: Record<string, unknown>, signal: AbortSignal) => Promise<InvokeOutcome>;
  /**
   * Editable inputs to start from, for example the entry's current values.
   * Fields the person has not touched follow the reviewed entry when a newer
   * version is reviewed, so a prefill never reverts someone else's change.
   */
  readonly initialInput?: Readonly<Record<string, unknown>>;
}

export type InteractionPhase =
  /** Not opened yet. */
  | "idle"
  /** Reading the target to confirm what the person reviews. */
  | "loading"
  /** The target could not be read; nothing is confirmed to submit against. */
  | "unreadable"
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
  /** A read is in flight (open, refresh or reread). */
  readonly reading: boolean;
  /** Inputs taken from the row; not editable. */
  readonly bound: Readonly<Record<string, unknown>>;
  /** Editable inputs, kept across refreshes, conflicts and failures. */
  readonly draft: Readonly<Record<string, unknown>>;
  /** Draft fields the person changed. */
  readonly touched: readonly string[];
  /** The person changed the draft away from the reviewed entry, unsaved. */
  readonly dirty: boolean;
  /** The entry the person is reviewing. */
  readonly reviewed: EntrySnapshot | null;
  /** A newer read that has not been reviewed yet. */
  readonly latest: EntrySnapshot | null;
  /** Touched fields that someone else also changed between `reviewed` and `latest`. */
  readonly contested: readonly string[];
  /** Runtime diagnostics from the last refusal or uncertain outcome. */
  readonly diagnostics: readonly InteractionDiagnostic[];
  /** The last read or transport failure, as thrown. */
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
  /** After a conflict, an uncertain write or a failed read: read again. */
  reread(): Promise<void>;
  /**
   * For a host with no `read`: the person has checked an uncertain write
   * elsewhere and chooses to continue.
   */
  acknowledgeUncertain(): void;
  /** Submit once with the reviewed version. Never retried. */
  submit(): Promise<void>;
  /**
   * Stop. An in-flight submit becomes `uncertain`, since it may have landed;
   * its answer, even a success, is then ignored.
   */
  cancel(): void;
  /** Draft inputs that differ from the reviewed entry's fields. */
  changes(): readonly FieldChange[];
  /** Fields that differ between the reviewed entry and the newer read. */
  latestChanges(): readonly FieldChange[];
}

/** Runtime codes and effect facts meaning a write may have landed (ADR-0023). */
const UNCERTAIN_CODES: ReadonlySet<string> = new Set(["OUTCOME_UNKNOWN", "PARTIAL_FAILURE"]);
const EDITABLE: ReadonlySet<InteractionPhase> = new Set([
  "idle", "loading", "unreadable", "ready", "changedSinceList", "failed", "conflict", "uncertain",
]);
const SUBMITTABLE: ReadonlySet<InteractionPhase> = new Set(["ready", "failed"]);
const REREADABLE: ReadonlySet<InteractionPhase> = new Set(["unreadable", "changedSinceList", "failed", "conflict", "uncertain"]);
const REFRESHABLE: ReadonlySet<InteractionPhase> = new Set(["unreadable", "ready", "changedSinceList", "failed"]);

export function createInteractionController(options: InteractionControllerOptions): InteractionController {
  const { interaction, row, read, invoke } = options;
  const versionInput = interaction.version;
  const locks = versionInput !== undefined;
  for (const { input, field } of interaction.bind) {
    if (!row || !(field in row)) throw new TypeError(`Input '${input}' is bound to row field '${field}', which the row does not carry.`);
  }
  const bound = Object.freeze(Object.fromEntries(interaction.bind.map(({ input, field }) => [input, row![field]])));
  const listSnapshot: EntrySnapshot | null = row && typeof row["id"] === "string" && typeof row["version"] === "number"
    ? Object.freeze({ id: row["id"], version: row["version"], data: Object.freeze({ ...row }) })
    : null;
  if (locks && !read && !listSnapshot) {
    throw new TypeError("An operation that locks a version needs a `read` or a row carrying id and version.");
  }
  const targetId = listSnapshot?.id;
  const fixed = new Set([...Object.keys(bound), ...(versionInput ? [versionInput] : [])]);
  const seeded = Object.fromEntries(Object.entries(options.initialInput ?? {}).filter(([field]) => !fixed.has(field)));

  let state: InteractionState = Object.freeze({
    phase: "idle",
    reading: false,
    bound,
    draft: Object.freeze(seeded),
    touched: [],
    dirty: false,
    reviewed: listSnapshot,
    latest: null,
    contested: [],
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
    const next = { ...state, ...patch };
    state = Object.freeze({
      ...next,
      dirty: next.touched.length > 0 && diff(next.draft, next.reviewed?.data ?? {}).length > 0,
      contested: contestedFields(next),
    });
    // A listener's failure is reported, never allowed to interrupt a
    // transition or the other listeners.
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  };
  const begin = () => {
    current?.abort();
    current = new AbortController();
    return { id: ++step, signal: current.signal };
  };
  const stale = (id: number) => id !== step || state.phase === "cancelled";

  /** Read the target; a wrong entry is a failed read. Background reads
   *  only record their failure. */
  const readInto = async (
    onFresh: (fresh: EntrySnapshot) => Partial<InteractionState>,
    onError: Partial<InteractionState>,
  ): Promise<boolean> => {
    if (!read) return false;
    const { id, signal } = begin();
    set({ reading: true });
    try {
      const fresh = await read(signal);
      if (stale(id)) return true;
      if (targetId !== undefined && fresh.id !== targetId) {
        set({ ...onError, reading: false, error: new Error(`Read returned entry '${fresh.id}', not '${targetId}'.`) });
        return true;
      }
      set({ ...onFresh(freeze(fresh)), reading: false, error: undefined });
    } catch (error) {
      if (!stale(id)) set({ ...onError, reading: false, error: error ?? new Error("Read failed.") });
    }
    return true;
  };
  /** A fresh read either confirms the reviewed version or waits for a review. */
  const confirm = (fresh: EntrySnapshot): Partial<InteractionState> => {
    if (state.latest && fresh.version < state.latest.version) return {};
    if (!state.reviewed || state.reviewed.version === fresh.version) {
      return { phase: "ready", reviewed: fresh, latest: null };
    }
    return { phase: "changedSinceList", latest: fresh };
  };

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
      await readInto(confirm, { phase: "unreadable" });
    },

    edit(field, value) {
      if (!EDITABLE.has(state.phase)) return;
      if (fixed.has(field)) throw new TypeError(`Input '${field}' comes from the reviewed row and cannot be edited.`);
      set({
        draft: Object.freeze({ ...state.draft, [field]: value }),
        touched: state.touched.includes(field) ? state.touched : [...state.touched, field],
      });
    },

    async refresh() {
      if (!REFRESHABLE.has(state.phase)) return;
      await readInto((fresh) => {
        if (state.phase === "unreadable") return confirm(fresh);
        if (state.latest && fresh.version < state.latest.version) return {};
        if (!state.reviewed) return { reviewed: fresh };
        if (fresh.version === state.reviewed.version) {
          return state.phase === "changedSinceList" ? { phase: "ready", latest: null } : { latest: null };
        }
        // Only a locked operation can be made stale by a newer version.
        return locks ? { phase: "changedSinceList", latest: fresh } : { latest: fresh };
      }, {});
    },

    review() {
      if (state.phase !== "changedSinceList" || !state.latest) return;
      const latest = state.latest;
      // Untouched prefilled fields follow the newer entry; the person's own
      // edits stay, and `contested` has already shown where they collide.
      const draft = Object.fromEntries(Object.entries(state.draft).map(([field, value]) =>
        state.touched.includes(field) || !(field in latest.data) ? [field, value] : [field, latest.data[field]]));
      set({ phase: "ready", reviewed: latest, latest: null, draft: Object.freeze(draft), diagnostics: [] });
    },

    async reread() {
      if (!REREADABLE.has(state.phase)) return;
      const from = state.phase;
      await readInto((fresh) => {
        const next = confirm(fresh);
        // A refusal that did not come from a moved version stays visible.
        return from === "conflict" && next.phase === "ready" ? { ...next, phase: "failed" } : next;
      }, { phase: from === "uncertain" ? "uncertain" : "unreadable" });
    },

    acknowledgeUncertain() {
      if (state.phase === "uncertain" && !read) set({ phase: "ready", error: undefined, diagnostics: [] });
    },

    async submit() {
      if (!SUBMITTABLE.has(state.phase) || state.reading) return;
      if (locks && !state.reviewed) return;
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
        set({ phase: "succeeded", result: outcome.data, touched: [] });
        return;
      }
      const { diagnostics } = outcome;
      const phase: InteractionPhase = diagnostics.some(isUncertain) ? "uncertain"
        : diagnostics.some((diagnostic) => diagnostic.code === "CONFLICT") ? "conflict"
        : "failed";
      set({ phase, diagnostics });
    },

    cancel() {
      if (state.phase === "cancelled" || state.phase === "succeeded") return;
      const submitting = state.phase === "submitting";
      current?.abort();
      current = null;
      step++;
      set({ phase: submitting ? "uncertain" : "cancelled", reading: false });
    },

    changes: () => diff(state.draft, state.reviewed?.data ?? {}),
    latestChanges() {
      if (!state.reviewed || !state.latest) return [];
      return comparable(state.reviewed, state.latest)
        .filter((field) => !same(state.reviewed!.data[field], state.latest!.data[field]))
        .map((field) => ({ field, before: state.reviewed!.data[field], after: state.latest!.data[field] }));
    },
  };
}

function isUncertain(diagnostic: InteractionDiagnostic): boolean {
  return UNCERTAIN_CODES.has(diagnostic.code)
    || diagnostic.failure?.outcome === "unknown"
    || diagnostic.failure?.outcome === "partial";
}

function contestedFields(state: InteractionState): string[] {
  if (!state.reviewed || !state.latest) return [];
  const fields = new Set(comparable(state.reviewed, state.latest));
  return state.touched.filter((field) => fields.has(field) && !same(state.reviewed!.data[field], state.latest!.data[field]));
}

/** Fields both snapshots carry. A list row is a projection, so a field it
 *  lacks is unknown, not changed. */
function comparable(reviewed: EntrySnapshot, latest: EntrySnapshot): string[] {
  return Object.keys(latest.data).filter((field) => field !== "version" && field in reviewed.data);
}

function diff(draft: Readonly<Record<string, unknown>>, before: Readonly<Record<string, unknown>>): FieldChange[] {
  return Object.entries(draft)
    .filter(([field, value]) => !same(before[field], value))
    .map(([field, after]) => ({ field, before: before[field], after }));
}

/** Structural equality for JSON-like values, independent of key order. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length
    && keysA.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function freeze(entry: EntrySnapshot): EntrySnapshot {
  return Object.freeze({ id: entry.id, version: entry.version, data: Object.freeze({ ...entry.data }) });
}
