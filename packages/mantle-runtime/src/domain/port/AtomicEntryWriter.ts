import type { ContentState } from "@aotter/mantle-spec";
import type { EntryRow } from "../model/EntryRow.js";
import type { CreateEntryArgs, DeleteEntryArgs, UpdateEntryArgs } from "./EntryRepository.js";

/** A prepared semantic mutation; adapters must enforce uniqueness and commit the whole list or none. */
export type AtomicEntryWrite =
  | { readonly kind: "create"; readonly args: CreateEntryArgs }
  | { readonly kind: "update"; readonly args: UpdateEntryArgs & {
      readonly expectedStatus: ContentState;
      readonly observedVersion: number;
    } }
  | { readonly kind: "delete"; readonly args: DeleteEntryArgs & {
      readonly observedVersion: number;
      readonly observedStatus: ContentState;
    } };

export interface AtomicEntryWriter {
  writeAtomically(writes: readonly AtomicEntryWrite[]): Promise<void>;
  /**
   * The current rows for these ids, read as `EntryRepository.get` reads one
   * (expired TTL rows hidden). Lets a group read its targets in one query
   * per collection instead of one per operation; absent rows are omitted.
   */
  readForWrite?(collection: string, ids: readonly string[]): Promise<readonly EntryRow[]>;
}
