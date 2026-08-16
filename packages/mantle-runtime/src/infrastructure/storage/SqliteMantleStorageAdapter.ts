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
  reconcileSchemaIndexes,
  reconcileSchemaSqlViews,
  schemaIndexMigrations,
} from "../boot/index.js";
import { DatabaseEntryRepository } from "../persistence/DatabaseEntryRepository.js";
import { DatabaseSiteConfigRepository } from "../persistence/DatabaseSiteConfigRepository.js";

/** Existing SQLite/D1 implementation behind the semantic preparation seam. */
export class SqliteMantleStorageAdapter implements MantleStorageAdapter {
  readonly nativeViewDialects = ["sqlite"] as const;

  constructor(
    private readonly db: DatabaseDriver,
    private readonly siteDefaults?: SiteDefaults,
    /** ponytail: alpha.7 facade state sharing; delete with the #667 binder. */
    private readonly siteConfig: SiteConfigRepository = new DatabaseSiteConfigRepository(db),
  ) {}

  async prepare(plan: RuntimePlan): Promise<PreparedMantleStorage> {
    const prepared = sqliteStoragePorts(this.db, plan);
    const fingerprint = await bootFingerprint({
      semanticFingerprint: plan.semanticFingerprint,
      siteDefaults: this.siteDefaults,
    });
    if (await isBootCurrent(this.db, fingerprint)) return prepared;

    await this.db.migrations.runAll(CANONICAL_MIGRATIONS);
    await this.siteConfig.seed(this.siteDefaults);
    assertDeploymentPlan(plan, { siteLocales: await this.siteConfig.readLocales() });

    const schemas = Object.values(plan.schemas).map((schema) => schema.manifest);
    const indexMigrations = schemaIndexMigrations(schemas);
    await this.db.migrations.runAll(indexMigrations);
    await reconcileSchemaIndexes(this.db, indexMigrations, schemas);
    await reconcileSchemaSqlViews(this.db, schemas);
    // Mark only after every check and reconciliation succeeds so retry is safe.
    await markBootCurrent(this.db, fingerprint);
    return prepared;
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
): PreparedMantleStorage {
  const schemas = new Map<string, SchemaManifest>(
    Object.values(plan.schemas).map((schema) => [schema.name, schema.manifest]),
  );
  return {
    entries: new DatabaseEntryRepository(db, schemas),
    views: new SqliteViewQueryExecutor(db, plan),
  };
}
