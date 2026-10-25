import type { EntryEditorPayload } from "../../lib/types";

type Entry = Pick<EntryEditorPayload["entry"], "id" | "collection" | "version" | "data">;

/**
 * A record form's local state against the entry it was loaded from (#1790). `base` is what the form edits: Save sends its
 * version, and the form is dirty when `data` differs from its data. A re-read of the editor payload never replaces unsaved
 * edits; a newer version that arrives meanwhile is only announced (`newer`), and Save then meets the stale-version CONFLICT.
 */
export interface EntryForm {
  readonly base: Entry;
  readonly data: Record<string, unknown>;
  /** A newer version read while the form was dirty; `dismissed` once the person chose to keep editing. */
  readonly newer: { readonly version: unknown; readonly dismissed: boolean } | null;
}

/** The server copy, taken as is: the first read, a reload, or the answer to the person's own save, publish or unpublish. */
export function loadEntryForm(entry: Entry): EntryForm {
  return { base: entry, data: entry.data, newer: null };
}

export function isEntryFormDirty(form: EntryForm): boolean {
  return JSON.stringify(form.data) !== JSON.stringify(form.base.data);
}

/** A re-read of the editor payload: a clean form follows it, a dirty one keeps its edits. */
export function followEntry(form: EntryForm | null, entry: Entry): EntryForm {
  if (!form || form.base.id !== entry.id || form.base.collection !== entry.collection || !isEntryFormDirty(form)) return loadEntryForm(entry);
  // same version: only related sections or metadata moved, which the page reads from the payload itself
  if (entry.version === form.base.version) return form.newer ? { ...form, newer: null } : form;
  return form.newer?.version === entry.version ? form : { ...form, newer: { version: entry.version, dismissed: false } };
}
