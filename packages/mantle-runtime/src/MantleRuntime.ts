import {
  EntryDataValidator,
  runtimeDiagnostic,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { AnyHandler, HandlerContext } from "./domain/model/HandlerContext.js";
import type { PreparedMantleRevision } from "./domain/model/PreparedMantleRevision.js";
import { SystemClock, type Clock } from "./domain/port/Clock.js";
import type { DeferredHookDispatcher } from "./domain/port/DeferredHookDispatcher.js";
import type { EntryReader } from "./domain/port/EntryReader.js";
import type { EntryRepository } from "./domain/port/EntryRepository.js";
import type { MediaAssetRepository } from "./domain/port/MediaAssetRepository.js";
import type { MediaAsset, MediaStorage } from "./domain/port/MediaStorage.js";
import type { PendingUploadRepository } from "./domain/port/PendingUploadRepository.js";
import {
  buildHandlerRegistry,
} from "./domain/port/HandlerRegistry.js";
import {
  RandomUuidGenerator,
  type IdGenerator,
} from "./domain/port/IdGenerator.js";
import type { MantleStorageAdapter } from "./domain/port/MantleStorageAdapter.js";
import type {
  LocalePolicyReader,
  SiteConfigRepository,
} from "./domain/port/SiteConfigRepository.js";
import type { ViewQueryOptions } from "./domain/port/ViewQueryExecutor.js";
import type { RuntimePlan } from "./domain/service/RuntimePlanCompiler.js";
import { TriggerIndex } from "./domain/service/TriggerIndex.js";
import { LifecycleHookingEntryRepository } from "./infrastructure/persistence/LifecycleHookingEntryRepository.js";
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
import type { RunDeferredHookRequest } from "./usecase/dto/lifecycle/index.js";
import type { InvokeProcedureResponse } from "./usecase/dto/procedure/index.js";
import {
  RunDeferredHookUseCase,
  RunLifecycleHooksUseCase,
} from "./usecase/lifecycle/index.js";
import {
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
  DeleteMediaAssetUseCase,
  GetMediaAssetUseCase,
  ListMediaAssetsUseCase,
  UpdateMediaAssetUseCase,
} from "./usecase/media/index.js";
import {
  InvokeBuiltinUseCase,
  InvokeProcedureUseCase,
} from "./usecase/procedure/index.js";
import {
  ExecuteViewUseCase,
  type ExecuteViewResponse,
} from "./usecase/view/index.js";
import { UpdateSiteSettingsUseCase } from "./usecase/site/index.js";
import {
  assertDeploymentPlan,
  prepareDeployment,
  type DeploymentPreparationOptions,
} from "./usecase/boot/ValidateBootUseCase.js";

export interface MantleRuntimePorts {
  readonly localePolicy?: LocalePolicyReader;
  readonly deferredHookDispatcher?: DeferredHookDispatcher;
  readonly clock?: Clock;
  readonly idgen?: IdGenerator;
  /** Host callback after a successful publishing-content mutation. */
  readonly onPublishingContentChange?: () => Promise<void>;
  readonly mediaStorage?: MediaStorage;
  readonly mediaAllowSvg?: boolean;
}

export interface CreateMantleRuntimeArgs {
  readonly prepared: PreparedMantleRevision;
  readonly ports?: MantleRuntimePorts;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
}

export interface BootMantleRuntimeArgs {
  readonly plan: RuntimePlan;
  readonly storage: MantleStorageAdapter;
  readonly ports?: MantleRuntimePorts;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly deployment?: Omit<DeploymentPreparationOptions, "handlerNames">;
}

export interface InvokeMantleProcedureRequest {
  readonly procedure: string;
  readonly input: unknown;
  readonly ctx: HandlerContext;
  readonly pathPrefix?: string;
}

export interface ExecuteMantleViewRequest {
  readonly view: string;
  readonly options?: ViewQueryOptions;
  readonly ctx?: HandlerContext;
  readonly pathPrefix?: string;
}

export interface InvokeMantleTriggerRequest {
  readonly trigger: string;
  readonly input: unknown;
  readonly ctx: HandlerContext;
  readonly pathPrefix?: string;
}

/** Programmatic Core bound to one prepared semantic revision. */
export interface MantleRuntime {
  readonly revision: string;
  /** Linked schemas needed by optional projections such as Mantle Web. */
  readonly schemas: ReadonlyMap<string, SchemaManifest>;
  readonly entries: EntryReader;
  readonly siteConfig: SiteConfigRepository | null;
  readonly updateSiteSettings: UpdateSiteSettingsUseCase | null;
  readonly media: MantleMedia | null;
  readonly createDraft: CreateDraftUseCase;
  readonly updateDraft: UpdateDraftUseCase;
  readonly getEntry: GetEntryUseCase;
  readonly listEntries: ListEntriesUseCase;
  readonly requestPublish: RequestPublishUseCase;
  readonly unpublish: UnpublishUseCase;
  readonly archive: ArchiveUseCase;
  readonly deleteEntry: DeleteEntryUseCase;
  invokeProcedure<O = unknown>(
    request: InvokeMantleProcedureRequest,
  ): Promise<InvokeProcedureResponse<O>>;
  executeView<R = Record<string, unknown>>(
    request: ExecuteMantleViewRequest,
  ): Promise<ExecuteViewResponse<R>>;
  invokeTrigger<O = unknown>(
    request: InvokeMantleTriggerRequest,
  ): Promise<InvokeProcedureResponse<O>>;
  runDeferredHook(request: RunDeferredHookRequest): Promise<void>;
}

export interface MantleMedia {
  readonly storage: MediaStorage;
  readonly createUpload: CreateMediaUploadUseCase;
  readonly commitUpload: CommitMediaUploadUseCase;
  readonly listAssets: ListMediaAssetsUseCase;
  readonly getAsset: GetMediaAssetUseCase;
  readonly updateAsset: UpdateMediaAssetUseCase;
  readonly deleteAsset: DeleteMediaAssetUseCase;
  resolve(id: string): Promise<MediaAsset | null>;
  resolveMany(ids: readonly string[]): Promise<ReadonlyMap<string, MediaAsset>>;
}

/** Prepare and bind once. Hosts remain responsible for caching and retry policy. */
export async function bootMantleRuntime(args: BootMantleRuntimeArgs): Promise<MantleRuntime> {
  const handlers = { ...(args.handlers ?? {}) };
  const prepared = await prepareDeployment(args.plan, args.storage, {
    ...args.deployment,
    handlerNames: Object.keys(handlers),
  });
  return createMantleRuntime({ prepared, handlers, ports: args.ports });
}

export function createMantleRuntime(args: CreateMantleRuntimeArgs): MantleRuntime {
  const { plan, storage: prepared } = args.prepared;
  const ports = args.ports ?? {};
  if (args.prepared.handlerNames) {
    assertDeploymentPlan(plan, { handlerNames: Object.keys(args.handlers ?? {}) });
  }
  const schemasByName = manifestMap(plan.schemas);
  const proceduresByName = manifestMap(plan.procedures);
  const viewsByName = manifestMap(plan.views);
  const triggersByName = manifestMap(plan.triggers);
  const registry = buildHandlerRegistry(args.handlers ?? {});
  const clock = ports.clock ?? SystemClock;
  const idgen = ports.idgen ?? RandomUuidGenerator;
  const localePolicy = ports.localePolicy ?? prepared.localePolicy;
  const validator = new EntryDataValidator();
  const triggerIndex = TriggerIndex.fromPlan(plan.lifecycleHooks, plan.triggers);

  let entries: EntryRepository;
  const entriesProxy: EntryRepository = {
    create: (request) => entries.create(request),
    get: (id) => entries.get(id),
    update: (request) => entries.update(request),
    delete: (request) => entries.delete(request),
    transitionStatus: (request) => entries.transitionStatus(request),
    list: (request) => entries.list(request),
    findByDataField: (request) => entries.findByDataField(request),
    findByDataFields: (request) => entries.findByDataFields(request),
  };
  const invokeBuiltin = new InvokeBuiltinUseCase(
    entriesProxy,
    schemasByName,
    clock,
    idgen,
    localePolicy,
    validator,
  );
  const invokeProcedure = new InvokeProcedureUseCase(
    registry,
    invokeBuiltin,
    proceduresByName,
  );
  const lifecycleHooks = new RunLifecycleHooksUseCase(
    triggerIndex,
    proceduresByName,
    (request) => invokeProcedure.execute(request),
  );
  entries = invalidateAfterWrites(
    new LifecycleHookingEntryRepository(
      prepared.entries,
      triggerIndex,
      lifecycleHooks,
      idgen,
      ports.deferredHookDispatcher,
    ),
    ports.onPublishingContentChange,
    (collection) =>
      (schemasByName.get(collection)?.spec.lifecycle ?? "publishing") === "publishing",
  );

  const createDraft = new CreateDraftUseCase(
    entries,
    schemasByName,
    clock,
    idgen,
    localePolicy,
    validator,
  );
  const updateDraft = new UpdateDraftUseCase(
    entries,
    schemasByName,
    clock,
    localePolicy,
    validator,
  );
  const getEntry = new GetEntryUseCase(entries);
  const listEntries = new ListEntriesUseCase(entries, schemasByName);
  const requestPublish = new RequestPublishUseCase(
    entries,
    schemasByName,
    clock,
    localePolicy,
    validator,
  );
  const unpublish = new UnpublishUseCase(entries, schemasByName, clock);
  const archive = new ArchiveUseCase(entries, schemasByName, clock);
  const deleteEntry = new DeleteEntryUseCase(entries, schemasByName);
  const executeView = new ExecuteViewUseCase(
    prepared.views,
    async (request) => {
      const procedure = proceduresByName.get(request.procedure);
      if (!procedure) return unknown("Procedure", request.procedure, request.pathPrefix);
      return invokeProcedure.execute({
        procedure,
        input: request.input,
        ctx: request.ctx,
        pathPrefix: request.pathPrefix,
      });
    },
    plan.views,
  );
  const runDeferredHook = new RunDeferredHookUseCase(lifecycleHooks);
  const siteConfig = prepared.siteConfig ?? null;
  const updateSiteSettings = siteConfig
    ? new UpdateSiteSettingsUseCase(siteConfig, ports.onPublishingContentChange)
    : null;
  const media = ports.mediaStorage
    ? createMedia(ports.mediaStorage, prepared.mediaAssets, prepared.pendingUploads, {
        clock,
        idgen,
        siteConfig,
        allowSvg: ports.mediaAllowSvg ?? false,
      })
    : null;

  return {
    revision: plan.semanticFingerprint,
    schemas: schemasByName,
    entries: prepared.entries,
    siteConfig,
    updateSiteSettings,
    media,
    createDraft,
    updateDraft,
    getEntry,
    listEntries,
    requestPublish,
    unpublish,
    archive,
    deleteEntry,
    invokeProcedure: (request) => {
      const procedure = proceduresByName.get(request.procedure);
      if (!procedure) {
        return Promise.resolve(unknown("Procedure", request.procedure, request.pathPrefix));
      }
      return invokeProcedure.execute({ ...request, procedure });
    },
    executeView: (request) => {
      const view = viewsByName.get(request.view);
      if (!view) return Promise.resolve(unknown("View", request.view, request.pathPrefix));
      return executeView.execute({ ...request, view });
    },
    invokeTrigger: (request) => {
      const trigger = plan.triggers[request.trigger];
      if (!trigger) return Promise.resolve(unknown("Trigger", request.trigger, request.pathPrefix));
      const procedure = proceduresByName.get(trigger.target);
      if (!procedure) {
        return Promise.resolve(unknown("Procedure", trigger.target, request.pathPrefix));
      }
      return invokeProcedure.execute({
        procedure,
        input: request.input,
        ctx: request.ctx,
        pathPrefix: request.pathPrefix ?? `manifest:Trigger/${request.trigger}`,
      });
    },
    runDeferredHook: (request) => runDeferredHook.execute(request),
  };
}

function createMedia(
  storage: MediaStorage,
  assets: MediaAssetRepository | undefined,
  pending: PendingUploadRepository | undefined,
  options: {
    readonly clock: Clock;
    readonly idgen: IdGenerator;
    readonly siteConfig: SiteConfigRepository | null;
    readonly allowSvg: boolean;
  },
): MantleMedia {
  if (!assets || !pending || !options.siteConfig) {
    throw new Error("mediaStorage requires prepared media and site-config repositories");
  }
  return {
    storage,
    createUpload: new CreateMediaUploadUseCase(
      storage,
      pending,
      options.clock,
      options.idgen,
      options.siteConfig,
      { allowSvg: options.allowSvg },
    ),
    commitUpload: new CommitMediaUploadUseCase(
      storage,
      pending,
      options.clock,
      assets,
    ),
    listAssets: new ListMediaAssetsUseCase(assets),
    getAsset: new GetMediaAssetUseCase(assets),
    updateAsset: new UpdateMediaAssetUseCase(assets),
    deleteAsset: new DeleteMediaAssetUseCase(storage, assets),
    resolve: (id) => assets.findById(id),
    resolveMany: (ids) => assets.findManyByIds(ids),
  };
}

function manifestMap<M>(
  record: Readonly<Record<string, { readonly name: string; readonly manifest: M }>>,
): ReadonlyMap<string, M> {
  return new Map(Object.values(record).map((item) => [item.name, item.manifest]));
}

function unknown(
  kind: "Procedure" | "View" | "Trigger",
  name: string,
  pathPrefix?: string,
): Extract<InvokeProcedureResponse<never>, { readonly ok: false }> {
  return {
    ok: false,
    diagnostic: runtimeDiagnostic({
      code: kind === "Procedure" ? "PROCEDURE_NOT_FOUND" : "NOT_FOUND",
      severity: "error",
      path: pathPrefix ?? `runtime:${kind}/${name}`,
      value: name,
      expected: `name of a ${kind} in the bound RuntimePlan`,
    }),
  };
}

function invalidateAfterWrites(
  inner: EntryRepository,
  invalidate: (() => Promise<void>) | undefined,
  affectsPublishingContent: (collection: string) => boolean,
): EntryRepository {
  if (!invalidate) return inner;
  return {
    async create(args) {
      const row = await inner.create(args);
      if (affectsPublishingContent(args.collection)) await invalidate();
      return row;
    },
    get: (id) => inner.get(id),
    async update(args) {
      const row = await inner.update(args);
      if (affectsPublishingContent(args.collection)) await invalidate();
      return row;
    },
    async delete(args) {
      const result = await inner.delete(args);
      if (result.removed && affectsPublishingContent(args.collection)) await invalidate();
      return result;
    },
    async transitionStatus(args) {
      const row = await inner.transitionStatus(args);
      if (affectsPublishingContent(args.collection)) await invalidate();
      return row;
    },
    list: (args) => inner.list(args),
    findByDataField: (args) => inner.findByDataField(args),
    findByDataFields: (args) => inner.findByDataFields(args),
  };
}
