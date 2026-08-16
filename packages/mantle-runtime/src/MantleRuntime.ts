import {
  EntryDataValidator,
  runtimeDiagnostic,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { AnyHandler, HandlerContext } from "./domain/model/HandlerContext.js";
import { SystemClock, type Clock } from "./domain/port/Clock.js";
import type { DeferredHookDispatcher } from "./domain/port/DeferredHookDispatcher.js";
import type { EntryReader } from "./domain/port/EntryReader.js";
import type { EntryRepository } from "./domain/port/EntryRepository.js";
import {
  buildHandlerRegistry,
  type HandlerRegistry,
} from "./domain/port/HandlerRegistry.js";
import {
  RandomUuidGenerator,
  type IdGenerator,
} from "./domain/port/IdGenerator.js";
import type { PreparedMantleStorage } from "./domain/port/MantleStorageAdapter.js";
import type { LocalePolicyReader } from "./domain/port/SiteConfigRepository.js";
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
  InvokeBuiltinUseCase,
  InvokeProcedureUseCase,
} from "./usecase/procedure/index.js";
import {
  ExecuteViewUseCase,
  type ExecuteViewResponse,
} from "./usecase/view/index.js";

export interface MantleRuntimePorts {
  readonly localePolicy?: LocalePolicyReader;
  readonly deferredHookDispatcher?: DeferredHookDispatcher;
  readonly clock?: Clock;
  readonly idgen?: IdGenerator;
  /** Host callback after a successful publishing-content mutation. */
  readonly onPublishingContentChange?: () => Promise<void>;
}

export interface CreateMantleRuntimeArgs {
  readonly plan: RuntimePlan;
  readonly prepared: PreparedMantleStorage;
  readonly ports?: MantleRuntimePorts;
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
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

/** Internal bridge used only by the alpha.7 full-facade compatibility path. */
export interface MantleRuntimeBinding {
  readonly runtime: MantleRuntime;
  readonly registry: HandlerRegistry;
  readonly clock: Clock;
  readonly idgen: IdGenerator;
  readonly invokeProcedure: InvokeProcedureUseCase;
  readonly executeView: ExecuteViewUseCase;
  readonly runDeferredHook: RunDeferredHookUseCase;
  readonly schemasByName: ReadonlyMap<string, SchemaManifest>;
  readonly proceduresByName: ReadonlyMap<string, ProcedureManifest>;
  readonly viewsByName: ReadonlyMap<string, ViewManifest>;
  readonly triggersByName: ReadonlyMap<string, TriggerManifest>;
}

export function createMantleRuntime(args: CreateMantleRuntimeArgs): MantleRuntime {
  return bindMantleRuntime(args).runtime;
}

export function bindMantleRuntime(args: CreateMantleRuntimeArgs): MantleRuntimeBinding {
  const { plan, prepared } = args;
  const ports = args.ports ?? {};
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

  const runtime: MantleRuntime = {
    revision: plan.semanticFingerprint,
    schemas: schemasByName,
    entries: prepared.entries,
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

  return {
    runtime,
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
