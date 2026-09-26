import type { StoreSelect, StoreSelectResult } from "../model/Store.js";

/** Storage-native execution of Store queries (ADR-0030). Optional per adapter. */
export interface StoreReader {
  select(query: StoreSelect): Promise<StoreSelectResult>;
}
