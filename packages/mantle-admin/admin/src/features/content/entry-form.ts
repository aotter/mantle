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
  /** A newer version read while the form was dirty; `dismissed` once the person chose to keep editing that version. */
  readonly newer: { readonly version: unknown; readonly dismissed: boolean } | null;
}

/** The server copy, taken as is: the first read, a reload, or another entry. */
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

/** The person's edit: reverted onto a known newer version, the form adopts it so Save and Publish send the current version. */
export function editEntryForm(form: EntryForm, data: Record<string, unknown>, latest: Entry | undefined): EntryForm {
  const next = { ...form, data };
  return next.newer && latest && !isEntryFormDirty(next) ? followEntry(next, latest) : next;
}

/**
 * The answer to the person's own save, publish or unpublish. `sent` is the data the write left on the server; edits made
 * while it was in flight (or kept through an unpublish) stay on top of the version it returned.
 */
export function settleEntryForm(form: EntryForm | null, sent: Record<string, unknown>, entry: Entry): EntryForm {
  if (!form || JSON.stringify(form.data) === JSON.stringify(sent)) return loadEntryForm(entry);
  return { base: entry, data: form.data, newer: null };
}

/** A stale-version CONFLICT: the notice for the newer version shows again, with its reload action, even if dismissed. */
export function reannounceNewer(form: EntryForm | null): EntryForm | null {
  return form?.newer?.dismissed ? { ...form, newer: { ...form.newer, dismissed: false } } : form;
}
