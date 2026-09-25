/** Every string the components render; hosts pass their own translations. */
export interface InteractionLabels {
  readonly submit: string;
  readonly submitting: string;
  readonly cancel: string;
  readonly close: string;
  readonly boundInputs: string;
  readonly reviewedEntry: string;
  readonly version: string;
  readonly changes: string;
  readonly latestChanges: string;
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly empty: string;
  readonly loading: string;
  readonly reading: string;
  readonly unreadable: string;
  readonly changedSinceList: string;
  readonly reviewLatest: string;
  readonly contested: string;
  readonly conflict: string;
  /** A conflict where the host cannot read the entry again (no `read`). */
  readonly conflictReopen: string;
  readonly uncertain: string;
  readonly reread: string;
  readonly acknowledgeUncertain: string;
  readonly failed: string;
  readonly succeeded: string;
  readonly cancelled: string;
}

export const defaultInteractionLabels: InteractionLabels = {
  submit: "Run",
  submitting: "Running…",
  cancel: "Cancel",
  close: "Close",
  boundInputs: "From the selected row",
  reviewedEntry: "Entry you are reviewing",
  version: "Version",
  changes: "Your changes",
  latestChanges: "What changed",
  field: "Field",
  before: "Before",
  after: "After",
  empty: "—",
  loading: "Loading the latest version…",
  reading: "Checking for changes…",
  unreadable: "This entry could not be loaded, so nothing can be submitted yet.",
  changedSinceList: "Someone changed this entry after you opened it. Review the newer version before you continue.",
  reviewLatest: "Review newer version",
  contested: "Someone else also changed fields you edited:",
  conflict: "This entry changed before your update was saved. Nothing was saved. Load the latest version and review it again.",
  conflictReopen: "This entry changed before your update was saved. Nothing was saved. Close this, then open the action again from the refreshed list.",
  uncertain: "We could not confirm whether this was saved. Check the latest version before trying again.",
  reread: "Load latest version",
  acknowledgeUncertain: "I checked; continue",
  failed: "This operation was refused.",
  succeeded: "Done.",
  cancelled: "Cancelled.",
};
