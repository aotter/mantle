import type { StoreSelectResult, ValidatedStoreSelect } from "../model/Store.js";

/** Executes Runtime-normalized Store queries; adapters still bind values and enforce their limits. */
export interface StoreReader {
  select(query: ValidatedStoreSelect): Promise<StoreSelectResult>;
}
