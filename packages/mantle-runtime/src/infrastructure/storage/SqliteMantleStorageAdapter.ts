import {
  DiagnosticError,
  runtimeDiagnostic,
  type SchemaManifest,
  type SiteDefaults,
} from "@aotter/mantle-spec";
import type { DatabaseDriver } from "../../domain/port/DatabaseDriver.js";
import type {
  MantleStorageAdapter,
  PreparedMantleStorage,
} from "../../domain/port/MantleStorageAdapter.js";
import type {
  ViewQueryExecutor,
  ViewQueryRequest,
  ViewQueryResult,
} from "../../domain/port/ViewQueryExecutor.js";
import type { SiteConfigRepository } from "../../domain/port/SiteConfigRepository.js";
import type { RuntimePlan } from "../../domain/service/RuntimePlanCompiler.js";
import {
  prepareSqliteView,
  type PreparedSqliteView,
} from "./SqliteViewCompiler.js";
import { assertDeploymentPlan } from "../../usecase/boot/ValidateBootUseCase.js";
import {
  bootFingerprint,
  CANONICAL_MIGRATIONS,
  isBootCurrent,
  markBootCurrent,
} from "../boot/index.js";
import { DatabaseEntryRepository } from "../persistence/DatabaseEntryRepository.js";
import { DatabaseMediaAssetRepository } from "../persistence/DatabaseMediaAssetRepository.js";
import { DatabasePendingUploadRepository } from "../persistence/DatabasePendingUploadRepository.js";
import { DatabaseSiteConfigRepository } from "../persistence/DatabaseSiteConfigRepository.js";
import {
  isAdditiveSchemaTableChange,
  mergeSchemaTableProjections,
  schemaTableMigrations,
  schemaTableProjection,
  validateSqliteSchemaTables,
} from "./SqliteSchemaTables.js";
import { storageFingerprint } from "./SqliteMigrationArtifact.js";

export interface SqliteMantleStorageAdapterOptions {
  /**
   * Decorate only the site-config repository used by preparation and the
   * prepared runtime. Platform adapters may attach platform-owned write
   * consequences without importing Runtime's concrete SQL repository.
   * The supplied repository remains the canonical SQLite authority.
   */
  readonly decorateSiteConfigRepository?: (
    canonical: SiteConfigRepository,
  ) => SiteConfigRepository;
  /** Managed deployments apply reviewed DDL before boot. Runtime validates
   *  this revision and never mutates physical schema ownership. */
  readonly managedStorageFingerprint?: string;
}

/** Existing SQLite/D1 implementation behind the semantic preparation seam. */
export class SqliteMantleStorageAdapter implements MantleStorageAdapter {
  readonly nativeViewDialects = ["sqlite"] as const;
  readonly siteConfig: SiteConfigRepository;
  private readonly canonicalSiteConfig: DatabaseSiteConfigRepository;

  constructor(
    private readonly db: DatabaseDriver,
    private readonly siteDefaults?: SiteDefaults,
    private readonly options: SqliteMantleStorageAdapterOptions = {},
  ) {
    const canonical = this.canonicalSiteConfig = new DatabaseSiteConfigRepository(db);
    this.siteConfig = options.decorateSiteConfigRepository?.(canonical) ?? canonical;
  }

  async prepare(plan: RuntimePlan): Promise<PreparedMantleStorage> {
    const prepared = sqliteStoragePorts(this.db, plan, this.siteConfig);
    const schemas = [...validateSqliteSchemaTables(Object.values(plan.schemas).map((schema) => schema.manifest))];
    await assertNoLegacyStorage(this.db);
    if (this.options.managedStorageFingerprint) {
      const planned = await storageFingerprint(schemas);
      if (planned !== this.options.managedStorageFingerprint) throw new Error("Managed storage fingerprint does not match the RuntimePlan.");
      await this.siteConfig.seed(this.siteDefaults);
      assertDeploymentPlan(plan, { siteLocales: await this.siteConfig.readLocales() });
      await assertSchemaTableOwnership(this.db, schemas);
      const active = await this.db.prepare("SELECT fingerprint FROM _mantle_storage_state WHERE id = 1").first<{ fingerprint: string }>();
      if (active?.fingerprint !== planned) throw new Error("Managed storage revision is not active.");
      this.canonicalSiteConfig.usePreparedLocales();
      return prepared;
    }
    const schemaMigrations = schemaTableMigrations(schemas);
    const fingerprint = await bootFingerprint({
      semanticFingerprint: plan.semanticFingerprint,
      siteDefaults: this.siteDefaults,
      schemaMigrations,
    });
    if (await isBootCurrent(this.db, fingerprint)) {
      this.canonicalSiteConfig.usePreparedLocales();
      return prepared;
    }

    await this.db.migrations.runAll(CANONICAL_MIGRATIONS);
    await this.siteConfig.seed(this.siteDefaults);
    assertDeploymentPlan(plan, { siteLocales: await this.siteConfig.readLocales() });
    await assertSchemaTableOwnership(this.db, schemas);
    await this.db.migrations.runAll(schemaMigrations);
    const tracked = new Map((await this.db.prepare("SELECT name, projection FROM _mantle_schema_tables")
      .all<{ name: string; projection: string }>()).map(({ name, projection }) => [name.toLowerCase(), projection]));
    for (const schema of schemas) {
      await this.db.prepare("INSERT INTO _mantle_schema_tables(name, projection) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET projection = excluded.projection")
        .bind(schema.metadata.name, mergeSchemaTableProjections(tracked.get(schema.metadata.name.toLowerCase()), schemaTableProjection(schema))).run();
    }
    await this.db.prepare("INSERT INTO _mantle_storage_state(id, fingerprint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint")
      .bind(await storageFingerprint(schemas)).run();
    // Mark only after every check and reconciliation succeeds so retry is safe.
    await markBootCurrent(this.db, fingerprint);
    return prepared;
  }
}

async function assertSchemaTableOwnership(
  db: DatabaseDriver,
  schemas: readonly SchemaManifest[],
): Promise<void> {
  const tracked = new Map((await db.prepare("SELECT name, projection FROM _mantle_schema_tables")
    .all<{ name: string; projection: string }>()).map(({ name, projection }) => [name.toLowerCase(), projection]));
  for (const schema of schemas) {
    const object = await db.prepare("SELECT type FROM sqlite_schema WHERE lower(name) = lower(?) LIMIT 1")
      .bind(schema.metadata.name).first<{ type: string }>();
    const previous = tracked.get(schema.metadata.name.toLowerCase());
    if (object && previous === undefined) {
      throw new Error(`Schema '${schema.metadata.name}' collides with an existing SQLite ${object.type}.`);
    }
    if (!object && previous !== undefined) {
      throw new Error(`Mantle-owned Schema table '${schema.metadata.name}' is missing.`);
    }
    if (previous !== undefined && !isAdditiveSchemaTableChange(previous, schemaTableProjection(schema))) {
      throw new Error(`Schema table '${schema.metadata.name}' requires an explicit destructive migration.`);
    }
  }
}

async function assertNoLegacyStorage(db: DatabaseDriver): Promise<void> {
  const legacy = await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND lower(name) = 'entries' LIMIT 1")
    .first<{ name: string }>();
  if (legacy) {
    throw new Error("LEGACY_STORAGE_RESET_REQUIRED: rebuild this pre-native-table database before upgrading; see docs/migration-0.1.2.md.");
  }
}

export class SqliteViewQueryExecutor implements ViewQueryExecutor {
  private readonly prepared = new Map<string, PreparedSqliteView>();

  constructor(
    private readonly db: DatabaseDriver,
    plan: RuntimePlan,
  ) {
    for (const view of Object.values(plan.views)) {
      const schema = view.query.kind === "declarative"
        ? plan.schemas[view.query.from]?.manifest
        : undefined;
      this.prepared.set(view.name, prepareSqliteView(view.query, view.name, schema));
    }
  }

  async execute<R = Record<string, unknown>>(
    request: ViewQueryRequest,
  ): Promise<ViewQueryResult<R>> {
    const prepared = this.prepared.get(request.view);
    if (!prepared) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "NOT_FOUND",
        severity: "error",
        path: `manifest:View/${request.view}`,
        value: request.view,
        expected: "a View in the prepared RuntimePlan",
      }));
    }
    const compiled = prepared.bind(request);
    const rows = await this.db.prepare(compiled.sql).bind(...compiled.params).all<R>();
    const normalized = prepared.normalizeRows(rows);
    return {
      rows: normalized,
      page: compiled.effectivePage,
      show: compiled.effectiveShow,
      hasMore: normalized.length === compiled.effectiveShow,
    };
  }
}

function sqliteStoragePorts(
  db: DatabaseDriver,
  plan: RuntimePlan,
  localePolicy: SiteConfigRepository,
): PreparedMantleStorage {
  const schemas = new Map<string, SchemaManifest>(
    Object.values(plan.schemas).map((schema) => [schema.name, schema.manifest]),
  );
  return {
    entries: new DatabaseEntryRepository(db, schemas),
    views: new SqliteViewQueryExecutor(db, plan),
    localePolicy,
    siteConfig: localePolicy,
    mediaAssets: new DatabaseMediaAssetRepository(db),
    pendingUploads: new DatabasePendingUploadRepository(db),
  };
}
