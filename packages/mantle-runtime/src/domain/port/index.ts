/**
 * `domain/port/` — interface contracts the use cases depend on.
 * Concrete implementations live in `infrastructure/` (or in adapter
 * packages like `@aotter/mantle-cloudflare`).
 *
 * Required adapter ports — `DatabaseDriver`, `KvCache`, `AssetServer`.
 * Optional feature ports — `MediaStorage` (public-bucket media
 * uploads), `EmailSender` (transactional email — passwordless auth,
 * receipts). Dispatcher-internal seams — `Clock`, `IdGenerator`,
 * `HandlerRegistry`, `EntryRepository`. Identity / session / OAuth
 * live outside the runtime via Better Auth (ADR-0014).
 *
 * Per the Aotter clean-architecture convention, no `*Port` suffix;
 * ports are discoverable by the package alone.
 */
export type {
  DatabaseDriver,
  PreparedStatement,
  RunResult,
  BatchResult,
  MigrationRunner,
  Migration,
} from "./DatabaseDriver.js";
export type { KvCache, KvPutOptions, KvListResult } from "./KvCache.js";
export type { AssetServer } from "./AssetServer.js";
export type {
  EntryRepository,
  CreateEntryArgs,
  UpdateEntryArgs,
  DeleteEntryArgs,
  TransitionStatusArgs,
  ListEntriesArgs,
  ListEntriesResult,
  FindEntryByDataFieldArgs,
  FindEntryByDataFieldsArgs,
  MutationHookFields,
} from "./EntryRepository.js";
export type { SiteConfigRepository } from "./SiteConfigRepository.js";
export type {
  PublishOrchestrator,
  PublishEntryRequest,
} from "./PublishOrchestrator.js";
export type {
  MediaStorage,
  CreateUploadArgs,
  CreateUploadVariantSpec,
  CreateUploadResult,
  UploadCapability,
  CommitUploadArgs,
  CommitUploadVariantSpec,
  GetPublicUrlArgs,
  DeleteObjectArgs,
  MediaAsset,
  MediaVariant,
  MediaVariantRole,
} from "./MediaStorage.js";
export { pickPrimaryVariant } from "./MediaStorage.js";
export type { MediaAssetRepository } from "./MediaAssetRepository.js";
export type {
  EmailSender,
  EmailSendArgs,
} from "./EmailSender.js";
export type {
  DeferredHookDispatcher,
  DeferredHookEnvelope,
  CtxSnapshot,
} from "./DeferredHookDispatcher.js";
export { ctxSnapshotFrom } from "./DeferredHookDispatcher.js";
export { type Clock, SystemClock } from "./Clock.js";
export { type IdGenerator, RandomUuidGenerator } from "./IdGenerator.js";
export {
  type HandlerRegistry,
  InMemoryHandlerRegistry,
  buildHandlerRegistry,
} from "./HandlerRegistry.js";
