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
   * Exactly the rows `EntryRepository.get` of the same store would return for
   * these ids (expired TTL rows hidden), with absent ids omitted. Lets a group
   * read its targets per collection instead of once per operation. A throw
   * falls back to per-operation reads.
   */
  readForWrite?(collection: string, ids: readonly string[]): Promise<readonly EntryRow[]>;
}
