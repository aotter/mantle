import type { ContentState } from "@aotter/mantle-spec";
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
}
