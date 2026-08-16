import {
  ValidateManifestsUseCase,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type SiteDefaults,
  type TriggerManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { AnyHandler } from "./domain/model/HandlerContext.js";
import type { AssetServer } from "./domain/port/AssetServer.js";
import type { DatabaseDriver } from "./domain/port/DatabaseDriver.js";
import type { DeferredHookDispatcher } from "./domain/port/DeferredHookDispatcher.js";
import type { EntryReader } from "./domain/port/EntryReader.js";
import type { MediaStorage } from "./domain/port/MediaStorage.js";
import type { SiteConfigRepository } from "./domain/port/SiteConfigRepository.js";
import type { Clock } from "./domain/port/Clock.js";
import type { IdGenerator } from "./domain/port/IdGenerator.js";
import type { HandlerRegistry } from "./domain/port/HandlerRegistry.js";

import {
  ArchiveUseCase,
  CreateDraftUseCase,
  DeleteEntryUseCase,
  GetEntryUseCase,
  ListEntriesUseCase,
  RequestPublishUseCase,
  UnpublishUseCase,
  UpdateDraftUseCase,
} from "./usecase/content/index.js";
import { InvokeProcedureUseCase } from "./usecase/procedure/index.js";
import { ExecuteViewUseCase } from "./usecase/view/index.js";
import {
  BootValidationError,
  prepareDeployment,
  ValidateBootUseCase,
} from "./usecase/boot/index.js";
import { RunDeferredHookUseCase } from "./usecase/lifecycle/index.js";
import {
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
  ListMediaAssetsUseCase,
  GetMediaAssetUseCase,
  UpdateMediaAssetUseCase,
  DeleteMediaAssetUseCase,
} from "./usecase/media/index.js";
import { UpdateSiteSettingsUseCase } from "./usecase/site/index.js";
import type { MediaAsset } from "./domain/port/MediaStorage.js";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "./domain/service/RuntimePlanCompiler.js";
import { DatabaseMediaAssetRepository } from "./infrastructure/persistence/DatabaseMediaAssetRepository.js";
import { DatabasePendingUploadRepository } from "./infrastructure/persistence/DatabasePendingUploadRepository.js";
import { DatabaseSiteConfigRepository } from "./infrastructure/persistence/DatabaseSiteConfigRepository.js";
import {
  SqliteMantleStorageAdapter,
} from "./infrastructure/storage/SqliteMantleStorageAdapter.js";
import { bindMantleRuntime, type MantleRuntime } from "./MantleRuntime.js";

/**
 * Alpha.7 full-product compatibility composition. It delegates forward
 * through parse/link/compile, storage preparation, and `bindMantleRuntime`,
 * then adds the still-combined Admin/media surfaces. New headless code
 * calls `createMantleRuntime` with an already prepared revision.
 */
export interface CreateCmsRuntimeArgs {
  readonly manifests: readonly Manifest[];
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly siteDefaults?: SiteDefaults;
  /** Adapter-owned HTTP namespaces that manifest Triggers must not claim. */
  readonly reservedHttpPathPrefixes?: readonly string[];
  /** Alpha.7 full-facade ports. Core binding does not accept either. */
  readonly db: DatabaseDriver;
  readonly assets: AssetServer;
  /** Optional media storage adapter. When unset, media MCP tools and
   *  admin upload endpoints are not registered — uploads return 404 /
   *  `MEDIA_NOT_CONFIGURED`. When set, the runtime wires
   *  `CreateMediaUpload` + `CommitMediaUpload` use cases backed by
   *  this adapter. Pending create-to-commit state remains canonical in DB. */
  readonly mediaStorage?: MediaStorage;
  /** Whether the SVG mime is allowed in `CreateMediaUpload`. Default
   *  false; object stores don't sanitize SVG payloads. */
  readonly mediaAllowSvg?: boolean;
  /** Optional at-least-once dispatcher for `after_*` lifecycle hooks.
   *  Queue acceptance is not atomic with the entry write. A rejection
   *  falls back, with the same event id, to best-effort `waitUntil`
   *  then inline execution. */
  readonly deferredHookDispatcher?: DeferredHookDispatcher;
  /** Optional clock — test seam. Defaults to `SystemClock`. */
  readonly clock?: Clock;
  /** Optional id generator — test seam. Defaults to `RandomUuidGenerator`. */
  readonly idgen?: IdGenerator;
  /** Adapter-owned invalidation after any successful content/site mutation. */
  readonly onPublicChange?: () => Promise<void>;
}

export interface CmsRuntime {
  /** Headless runtime consumed by optional downstream packages. */
  readonly core: MantleRuntime;
  /** Canonical, immutable semantics shared with preparation and adapters. */
  readonly plan: RuntimePlan;
  /** Raw database driver, retained for adapter compatibility.
   *  @deprecated Use purpose-shaped surfaces such as `entryReader` and
   *  `siteConfig`; adapters should retain their injected driver for tables
   *  they own. */
  readonly db: DatabaseDriver;
  readonly assets: AssetServer;
  /** Schema-aware, lifecycle-neutral entry reads for adapter-owned routes. */
  readonly entryReader: EntryReader;

  /** Use cases (pre-wired with ports + clock + idgen). */
  readonly createDraft: CreateDraftUseCase;
  readonly updateDraft: UpdateDraftUseCase;
  readonly getEntry: GetEntryUseCase;
  readonly listEntries: ListEntriesUseCase;
  readonly requestPublish: RequestPublishUseCase;
  readonly unpublish: UnpublishUseCase;
  readonly archive: ArchiveUseCase;
  readonly deleteEntry: DeleteEntryUseCase;
  readonly invokeProcedure: InvokeProcedureUseCase;
  readonly executeView: ExecuteViewUseCase;
  readonly validateBoot: ValidateBootUseCase;
  readonly siteConfig: SiteConfigRepository;
  readonly updateSiteSettings: UpdateSiteSettingsUseCase;
  /** Pre-wired media use cases when `mediaStorage` was supplied; null
   *  otherwise. Adapters route admin endpoints + MCP tools off this.
   *
   *  `resolve` / `resolveMany` materialise the variants set of a
   *  committed asset by id — entry data references assets via
   *  `x-mantle-ref: media_assets`, and renderers call these to emit
   *  `<picture>`. `resolveMany` batches a render-pass's worth of
   *  references in one DB round trip. */
  readonly media: {
    readonly storage: MediaStorage;
    readonly createUpload: CreateMediaUploadUseCase;
    readonly commitUpload: CommitMediaUploadUseCase;
    /** Admin media-library use cases (#434): list/get/patch/delete over
     *  committed assets. Adapters route `/admin/api/media*` off these. */
    readonly listAssets: ListMediaAssetsUseCase;
    readonly getAsset: GetMediaAssetUseCase;
    readonly updateAsset: UpdateMediaAssetUseCase;
    readonly deleteAsset: DeleteMediaAssetUseCase;
    resolve(id: string): Promise<MediaAsset | null>;
    resolveMany(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>>;
  } | null;
  /** Validate and drive a deferred after-hook from an untrusted Queue
   *  body. Failures escape so the adapter can retry/DLQ the event. */
  readonly runDeferredHook: RunDeferredHookUseCase;

  /** Adapter-helper bag. */
  readonly registry: HandlerRegistry;
  readonly schemasByName: ReadonlyMap<string, SchemaManifest>;
  readonly proceduresByName: ReadonlyMap<string, ProcedureManifest>;
  readonly viewsByName: ReadonlyMap<string, ViewManifest>;
  readonly triggers: readonly TriggerManifest[];
  readonly triggersByName: ReadonlyMap<string, TriggerManifest>;
  readonly clock: Clock;
  readonly idgen: IdGenerator;
}

/** Alpha.7 full-product facade. New headless consumers use createMantleRuntime. */
export async function createCmsRuntime(args: CreateCmsRuntimeArgs): Promise<CmsRuntime> {
  const validation = ValidateManifestsUseCase.run({ manifests: args.manifests });
  if (!validation.linked) {
    throw new BootValidationError(validation.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      phase: "boot",
    })));
  }
  const compilation = compileRuntimePlan(validation.linked);
  if (!compilation.ok) {
    throw new BootValidationError(compilation.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      phase: "boot",
    })));
  }
  const plan = compilation.value;
  const siteConfig = new DatabaseSiteConfigRepository(args.db);
  const storageAdapter = new SqliteMantleStorageAdapter(
    args.db,
    args.siteDefaults,
    siteConfig,
  );
  const prepared = await prepareDeployment(plan, storageAdapter, {
    handlerNames: Object.keys(args.handlers ?? {}),
    reservedHttpPathPrefixes: args.reservedHttpPathPrefixes,
  });
  const bound = bindMantleRuntime({
    plan,
    prepared,
    handlers: args.handlers,
    ports: {
      localePolicy: siteConfig,
      deferredHookDispatcher: args.deferredHookDispatcher,
      clock: args.clock,
      idgen: args.idgen,
      onPublishingContentChange: args.onPublicChange,
    },
  });
  const {
    runtime: core,
    registry,
    clock,
    idgen,
    invokeProcedure,
    executeView,
    runDeferredHook,
    schemasByName,
    proceduresByName,
    viewsByName,
    triggersByName,
  } = bound;
  const triggers = [...triggersByName.values()];
  const entryReader = core.entries;
  const mediaAssets = new DatabaseMediaAssetRepository(args.db);
  const pendingUploads = new DatabasePendingUploadRepository(args.db);
  const updateSiteSettings = new UpdateSiteSettingsUseCase(siteConfig, args.onPublicChange);

  const validateBoot = new ValidateBootUseCase();

  const media = args.mediaStorage
    ? {
        storage: args.mediaStorage,
        createUpload: new CreateMediaUploadUseCase(
          args.mediaStorage,
          pendingUploads,
          clock,
          idgen,
          siteConfig,
          { allowSvg: args.mediaAllowSvg ?? false },
        ),
        commitUpload: new CommitMediaUploadUseCase(
          args.mediaStorage,
          pendingUploads,
          clock,
          mediaAssets,
        ),
        listAssets: new ListMediaAssetsUseCase(mediaAssets),
        getAsset: new GetMediaAssetUseCase(mediaAssets),
        updateAsset: new UpdateMediaAssetUseCase(mediaAssets),
        deleteAsset: new DeleteMediaAssetUseCase(args.mediaStorage, mediaAssets),
        resolve: (id: string) => mediaAssets.findById(id),
        resolveMany: (ids: readonly string[]) => mediaAssets.findManyByIds(ids),
      }
    : null;

  return {
    core,
    plan,
    db: args.db,
    assets: args.assets,
    entryReader,

    createDraft: core.createDraft,
    updateDraft: core.updateDraft,
    getEntry: core.getEntry,
    listEntries: core.listEntries,
    requestPublish: core.requestPublish,
    unpublish: core.unpublish,
    archive: core.archive,
    deleteEntry: core.deleteEntry,
    invokeProcedure,
    executeView,
    validateBoot,
    siteConfig,
    updateSiteSettings,
    media,
    runDeferredHook,

    registry,
    schemasByName,
    proceduresByName,
    viewsByName,
    triggers,
    triggersByName,
    clock,
    idgen,
  };
}
