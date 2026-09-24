import type { RuntimePlan } from "../service/RuntimePlanCompiler.js";
import type { AtomicEntryWriter } from "./AtomicEntryWriter.js";
import type { EntryReader } from "./EntryReader.js";
import type { EntryRepository } from "./EntryRepository.js";
import type { ExpirySweeper } from "./ExpirySweeper.js";
import type { MediaAssetRepository } from "./MediaAssetRepository.js";
import type { PendingUploadRepository } from "./PendingUploadRepository.js";
import type { LocalePolicyReader } from "./SiteConfigRepository.js";
import type { SiteConfigRepository } from "./SiteConfigRepository.js";
import type { ViewQueryExecutor } from "./ViewQueryExecutor.js";

export interface PreparedMantleStorage {
  readonly entries: EntryRepository & EntryReader;
  /** Absence means the adapter cannot promise all-or-nothing entry writes. */
  readonly atomicEntries?: AtomicEntryWriter;
  /** Absence means this adapter cannot physically sweep expired rows. */
  readonly expiry?: ExpirySweeper;
  readonly views: ViewQueryExecutor;
  readonly localePolicy?: LocalePolicyReader;
  readonly siteConfig?: SiteConfigRepository;
  readonly mediaAssets?: MediaAssetRepository;
  readonly pendingUploads?: PendingUploadRepository;
}

/** Prepare one immutable plan against storage already owned by the host. */
export interface MantleStorageAdapter {
  /** Native View dialects accepted by this adapter. Declarative Views are required. */
  readonly nativeViewDialects?: readonly string[];
  /** Declares logical TTL filtering on every semantic read and physical sweep support. */
  readonly supportsTtl?: boolean;
  prepare(plan: RuntimePlan): Promise<PreparedMantleStorage>;
}
