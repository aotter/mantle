import {
  partitionManifests,
  runtimeDiagnostic,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type SiteDefaults,
  type TriggerManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { AnyHandler } from "./domain/model/HandlerContext.js";
import type { TemplateRegistry } from "./domain/model/TemplateRegistry.js";
import type { AssetServer } from "./domain/port/AssetServer.js";
import type { DatabaseDriver } from "./domain/port/DatabaseDriver.js";
import type { DeferredHookDispatcher } from "./domain/port/DeferredHookDispatcher.js";
import type { EntryReader } from "./domain/port/EntryReader.js";
import type { EntryRepository } from "./domain/port/EntryRepository.js";
import type { KvCache } from "./domain/port/KvCache.js";
import type { MediaStorage } from "./domain/port/MediaStorage.js";
import type { PublishOrchestrator } from "./domain/port/PublishOrchestrator.js";
import type { SiteConfigRepository } from "./domain/port/SiteConfigRepository.js";
import { SystemClock, type Clock } from "./domain/port/Clock.js";
import {
  RandomUuidGenerator,
  type IdGenerator,
} from "./domain/port/IdGenerator.js";
import {
  buildHandlerRegistry,
  type HandlerRegistry,
} from "./domain/port/HandlerRegistry.js";

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
import {
  InvokeBuiltinUseCase,
  InvokeProcedureUseCase,
} from "./usecase/procedure/index.js";
import { ExecuteViewUseCase } from "./usecase/view/index.js";
import { ValidateBootUseCase } from "./usecase/boot/index.js";
import {
  RunDeferredHookUseCase,
  RunLifecycleHooksUseCase,
} from "./usecase/lifecycle/index.js";
import {
  ComposeEntrySeoMetaUseCase,
  ComposeLlmsTxtUseCase,
  ComposeSitemapUseCase,
  PreviewEntryUseCase,
  RenderEntryLiveUseCase,
  RenderListLiveUseCase,
} from "./usecase/render/index.js";
import {
  CommitMediaUploadUseCase,
  CreateMediaUploadUseCase,
  ListMediaAssetsUseCase,
  GetMediaAssetUseCase,
  UpdateMediaAssetUseCase,
  DeleteMediaAssetUseCase,
} from "./usecase/media/index.js";
import type { PublicPathResolver } from "./domain/service/PublicPathResolver.js";

import type { MediaAsset } from "./domain/port/MediaStorage.js";
import { TemplateRegistry as TemplateRegistryImpl } from "./domain/model/TemplateRegistry.js";
import { TriggerIndex } from "./domain/service/TriggerIndex.js";
import { DatabaseEntryRepository } from "./infrastructure/persistence/DatabaseEntryRepository.js";
import { DatabaseMediaAssetRepository } from "./infrastructure/persistence/DatabaseMediaAssetRepository.js";
import { DatabaseSiteConfigRepository } from "./infrastructure/persistence/DatabaseSiteConfigRepository.js";
import { LifecycleHookingEntryRepository } from "./infrastructure/persistence/LifecycleHookingEntryRepository.js";
import { HtmlPublishOrchestrator } from "./infrastructure/render/index.js";
import {
  CANONICAL_MIGRATIONS,
  reconcileSchemaIndexes,
  schemaIndexMigrations,
} from "./infrastructure/boot/index.js";

/**
 * `createCmsRuntime` — assembly root. Per the clean-architecture
 * convention, this file is the only place that wires concrete
 * adapters (`infrastructure/persistence/*`, `infrastructure/render/*`)
 * to use cases (`usecase/content/*`, etc.) via ports
 * (`domain/port/*`).
 *
 * Adapters call this once at boot, pass the required ADR-0011 ports +
 * the consumer's manifests + handlers + templates + siteDefaults, and
 * receive a `CmsRuntime` they expose to their HTTP framework's
 * routing layer.
 *
 * `bootInit()` runs migrations, seeds `siteDefaults`, and validates
 * the manifest set against the registry. Throws `BootValidationError`
 * on any boot diagnostic — adapters surface the error in their init
 * logs.
 */
export interface CreateCmsRuntimeArgs {
  readonly manifests: readonly Manifest[];
  readonly handlers?: Readonly<Record<string, AnyHandler>>;
  readonly templates?: TemplateRegistry;
  readonly siteDefaults?: SiteDefaults;
  /** Required ADR-0011 ports. */
  readonly db: DatabaseDriver;
  readonly kv: KvCache;
  readonly assets: AssetServer;
  /** Optional public-path resolver. When set, the publish pipeline
   *  composes SEO/AEO meta on every entry render and the resolved
   *  paths drive sitemap / hreflang sibling URLs. Adapters that
   *  expose request-time render routes should also pass this through
   *  so request-time HTML matches publish-time HTML. */
  readonly publicPathResolver?: PublicPathResolver;
  /** Optional media storage adapter. When unset, media MCP tools and
   *  admin upload endpoints are not registered — uploads return 404 /
   *  `MEDIA_NOT_CONFIGURED`. When set, the runtime wires
   *  `CreateMediaUpload` + `CommitMediaUpload` use cases backed by
   *  this adapter. The KV mapping for pending uploads reuses `args.kv`. */
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
}

export interface CmsRuntime {
  /** Raw ADR-0011 database driver, retained for adapter compatibility.
   *  @deprecated Use `entryReader` or a purpose-shaped use case for entry reads. */
  readonly db: DatabaseDriver;
  readonly kv: KvCache;
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
  readonly composeLlmsTxt: ComposeLlmsTxtUseCase;
  readonly composeSitemap: ComposeSitemapUseCase;
  readonly composeEntrySeoMeta: ComposeEntrySeoMetaUseCase;
  readonly renderEntryLive: RenderEntryLiveUseCase;
  readonly renderListLive: RenderListLiveUseCase;
  readonly previewEntry: PreviewEntryUseCase;
  readonly validateBoot: ValidateBootUseCase;
  readonly publishOrchestrator: PublishOrchestrator;
  readonly siteConfig: SiteConfigRepository;
  /** The resolver passed at boot, or `null` when the consumer didn't
   *  supply one. Adapters use this to derive URLs (sitemap, SEO
   *  hreflangs) without rebuilding the mapping. */
  readonly publicPathResolver: PublicPathResolver | null;
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
  readonly templates: TemplateRegistry;
  readonly schemasByName: ReadonlyMap<string, SchemaManifest>;
  readonly proceduresByName: ReadonlyMap<string, ProcedureManifest>;
  readonly viewsByName: ReadonlyMap<string, ViewManifest>;
  readonly triggers: readonly TriggerManifest[];
  readonly triggersByName: ReadonlyMap<string, TriggerManifest>;
  readonly clock: Clock;
  readonly idgen: IdGenerator;

  /** Run migrations, seed siteDefaults, and validate boot. Adapters
   *  call this once per isolate before routing requests. */
  bootInit(): Promise<void>;
}

export function createCmsRuntime(args: CreateCmsRuntimeArgs): CmsRuntime {
  const partitioned = partitionManifests([...args.manifests]);
  const schemasByName = new Map<string, SchemaManifest>();
  for (const s of partitioned.schemas) schemasByName.set(s.metadata.name, s);
  const proceduresByName = new Map<string, ProcedureManifest>();
  for (const p of partitioned.procedures) proceduresByName.set(p.metadata.name, p);
  const viewsByName = new Map<string, ViewManifest>();
  for (const v of partitioned.views) viewsByName.set(v.metadata.name, v);
  const triggersByName = new Map<string, TriggerManifest>();
  for (const t of partitioned.triggers) triggersByName.set(t.metadata.name, t);

  const registry = buildHandlerRegistry(args.handlers ?? {});
  const templates = args.templates ?? new TemplateRegistryImpl();
  const clock = args.clock ?? SystemClock;
  const idgen = args.idgen ?? RandomUuidGenerator;

  // Repositories: DB-backed inner + lifecycle-hook decorator. Every
  // mutation through `entries` (create / update / delete /
  // transitionStatus) fires the matching Triggers via
  // `RunLifecycleHooksUseCase`. Symmetric chokepoint per POC ADR-0014:
  // MCP, admin, and builtin paths all hit the same wrapped repository.
  const innerEntries = new DatabaseEntryRepository(args.db, schemasByName);
  const entryReader: EntryReader = innerEntries;
  const triggerIndex = new TriggerIndex(partitioned.triggers);
  const siteConfig = new DatabaseSiteConfigRepository(args.db);
  // `entries` is filled below — assigned via `let` so the lifecycle
  // hooks (which run procedures, which can themselves write entries
  // via builtin handlers) close over the wrapped repo, not the bare
  // DB-backed one. Without this every builtin write inside a hook
  // would skip the decorator and silently bypass downstream hooks.
  let entries: EntryRepository;
  const entriesProxy: EntryRepository = {
    create: (a) => entries.create(a),
    get: (id) => entries.get(id),
    update: (a) => entries.update(a),
    delete: (a) => entries.delete(a),
    transitionStatus: (a) => entries.transitionStatus(a),
    list: (a) => entries.list(a),
    findByDataField: (a) => entries.findByDataField(a),
    findByDataFields: (a) => entries.findByDataFields(a),
  };
  const invokeBuiltin = new InvokeBuiltinUseCase(
    entriesProxy,
    schemasByName,
    clock,
    idgen,
    siteConfig,
  );
  const invokeProcedure = new InvokeProcedureUseCase(registry, invokeBuiltin, proceduresByName);
  const lifecycleHooks = new RunLifecycleHooksUseCase(
    triggerIndex,
    proceduresByName,
    (req) => invokeProcedure.execute(req),
  );
  entries = new LifecycleHookingEntryRepository(
    innerEntries,
    triggerIndex,
    lifecycleHooks,
    idgen,
    args.deferredHookDispatcher,
  );
  const runDeferredHook = new RunDeferredHookUseCase(lifecycleHooks);
  const publicPathResolver = args.publicPathResolver ?? null;
  const composeEntrySeoMeta = new ComposeEntrySeoMetaUseCase(entryReader);
  const composeLlmsTxt = new ComposeLlmsTxtUseCase(entryReader);
  const mediaAssets = new DatabaseMediaAssetRepository(args.db);
  const publishOrchestrator = new HtmlPublishOrchestrator(
    entryReader,
    args.kv,
    publicPathResolver,
    composeEntrySeoMeta,
    composeLlmsTxt,
    schemasByName,
    mediaAssets,
  );

  // Content / view / boot use cases. They see `entries` only as the
  // chokepoint port — hook firing is invisible to them.
  const createDraft = new CreateDraftUseCase(entries, schemasByName, clock, idgen, siteConfig);
  const updateDraft = new UpdateDraftUseCase(entries, schemasByName, clock, siteConfig);
  const getEntry = new GetEntryUseCase(entries);
  const listEntries = new ListEntriesUseCase(entries, schemasByName);
  const contentPublishEffects = { publishOrchestrator, siteConfig, templates };
  const requestPublish = new RequestPublishUseCase(
    entries,
    schemasByName,
    clock,
    contentPublishEffects,
    siteConfig,
  );
  const unpublish = new UnpublishUseCase(entries, schemasByName, clock, contentPublishEffects);
  const archive = new ArchiveUseCase(entries, schemasByName, clock, contentPublishEffects);
  const deleteEntry = new DeleteEntryUseCase(entries, schemasByName);
  const executeView = new ExecuteViewUseCase(
    args.db,
    async (request) => {
      const procedure = proceduresByName.get(request.procedure);
      if (!procedure) {
        return {
          ok: false as const,
          diagnostic: runtimeDiagnostic({
            code: "GUARD_PROCEDURE_UNKNOWN",
            severity: "error",
            path: request.pathPrefix,
            value: request.procedure,
            expected: "name of a declared Procedure",
          }),
        };
      }
      return invokeProcedure.execute({
        procedure,
        input: request.input,
        ctx: request.ctx,
        pathPrefix: request.pathPrefix,
      });
    },
    schemasByName,
  );
  const composeSitemap = new ComposeSitemapUseCase(entryReader);
  const renderEntryLive = new RenderEntryLiveUseCase(
    entryReader,
    templates,
    publicPathResolver,
    composeEntrySeoMeta,
    schemasByName,
    mediaAssets,
  );
  const renderListLive = new RenderListLiveUseCase(
    entryReader,
    templates,
    schemasByName,
    mediaAssets,
  );
  const previewEntry = new PreviewEntryUseCase(
    entryReader,
    templates,
    publicPathResolver,
    composeEntrySeoMeta,
    schemasByName,
    mediaAssets,
  );
  const validateBoot = new ValidateBootUseCase();

  const media = args.mediaStorage
    ? {
        storage: args.mediaStorage,
        createUpload: new CreateMediaUploadUseCase(
          args.mediaStorage,
          args.kv,
          clock,
          idgen,
          siteConfig,
          { allowSvg: args.mediaAllowSvg ?? false },
        ),
        commitUpload: new CommitMediaUploadUseCase(
          args.mediaStorage,
          args.kv,
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
    db: args.db,
    kv: args.kv,
    assets: args.assets,
    entryReader,

    createDraft,
    updateDraft,
    getEntry,
    listEntries,
    requestPublish,
    unpublish,
    archive,
    deleteEntry,
    invokeProcedure,
    executeView,
    composeLlmsTxt,
    composeSitemap,
    composeEntrySeoMeta,
    renderEntryLive,
    renderListLive,
    previewEntry,
    validateBoot,
    publishOrchestrator,
    siteConfig,
    publicPathResolver,
    media,
    runDeferredHook,

    registry,
    templates,
    schemasByName,
    proceduresByName,
    viewsByName,
    triggers: partitioned.triggers,
    triggersByName,
    clock,
    idgen,

    async bootInit(): Promise<void> {
      const schemas = partitioned.schemas;
      await args.db.migrations.runAll(CANONICAL_MIGRATIONS);
      await siteConfig.seed(args.siteDefaults);
      const siteLocales = await siteConfig.readLocales();
      validateBoot.assert({
        manifests: args.manifests,
        registry,
        siteLocales,
      });
      const indexMigrations = schemaIndexMigrations(schemas);
      await args.db.migrations.runAll(indexMigrations);
      await reconcileSchemaIndexes(args.db, indexMigrations, schemas);
    },
  };
}
