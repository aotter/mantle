import type { RuntimePlan } from "../service/RuntimePlanCompiler.js";
import type { EntryReader } from "./EntryReader.js";
import type { EntryRepository } from "./EntryRepository.js";
import type { ViewQueryExecutor } from "./ViewQueryExecutor.js";

export interface PreparedMantleStorage {
  readonly entries: EntryRepository & EntryReader;
  readonly views: ViewQueryExecutor;
}

/** Prepare one immutable plan against storage already owned by the host. */
export interface MantleStorageAdapter {
  /** Native View dialects accepted by this adapter. Declarative Views are required. */
  readonly nativeViewDialects?: readonly string[];
  prepare(plan: RuntimePlan): Promise<PreparedMantleStorage>;
}
