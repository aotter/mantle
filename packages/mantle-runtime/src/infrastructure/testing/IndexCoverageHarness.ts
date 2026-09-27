import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  RESERVED_ENTRY_COLUMNS,
  resolveLifecycle,
  type FilterAst,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import type { RuntimePlan } from "../../domain/service/RuntimePlanCompiler.js";
import { scopeStoreWhere } from "../../usecase/store/validateStoreQuery.js";
import { bindStoreViewSelect } from "../../usecase/view/ExecuteViewUseCase.js";
import { SqliteStoreQueryCompiler } from "../persistence/SqliteStoreQuery.js";
import { compileView } from "../storage/SqliteViewCompiler.js";
import { CANONICAL_MIGRATIONS } from "../boot/canonicalMigrations.js";
import { liveTtlCondition, quoteIdent, schemaTableMigrations } from "../storage/SqliteSchemaTables.js";

export interface IndexCoverageOptions {
  readonly rowsPerSchema?: number;
  readonly requirePublic?: boolean;
  readonly requiredViews?: readonly string[];
}

export interface IndexCoveragePath {
  readonly view: string;
  readonly schema: string;
  readonly surface: string;
  readonly required: boolean;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly plan: readonly string[];
  readonly usedIndexes: readonly string[];
  readonly resultCount: number;
  readonly tableScan: boolean;
  readonly indexedScan: boolean;
  readonly temporarySort: boolean;
  readonly dataAccessFields: readonly string[];
  readonly schemaIndexRequired: boolean;
  readonly schemaIndexUsed: boolean;
  readonly passed: boolean;
  readonly findings: readonly string[];
}

export interface IndexCoverageReport {
  readonly version: 1;
  readonly sqliteVersion: string;
  readonly rowsPerSchema: number;
  readonly paths: readonly IndexCoveragePath[];
  readonly summary: {
    readonly views: number;
    readonly required: number;
    readonly requiredFailures: number;
    readonly missingRequiredViews: readonly string[];
    readonly tableScans: number;
    readonly temporarySorts: number;
  };
}

interface QueryPlanRow {
  readonly detail: string;
}

/** Execute real compiled Views against the real schema in crowded SQLite. */
export function inspectIndexCoverage(
  runtimePlan: RuntimePlan,
  options: IndexCoverageOptions = {},
): IndexCoverageReport {
  const rowsPerSchema = clampRows(options.rowsPerSchema);
  const requiredNames = new Set(options.requiredViews ?? []);
  const schemas = Object.values(runtimePlan.schemas).map((entry) => entry.manifest);
  const views = Object.values(runtimePlan.views).map((entry) => entry.manifest);
  const schemasByName = new Map(schemas.map((schema) => [schema.metadata.name, schema]));
  const db = new DatabaseSync(":memory:");

  try {
    for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
    for (const migration of schemaTableMigrations(schemas)) db.exec(migration.sql);
    seedSchemas(db, schemas, rowsPerSchema);

    const paths: IndexCoveragePath[] = [];
    for (const view of views) paths.push(inspectView(
      db, view, runtimePlan, schemasByName,
      (options.requirePublic === true && view.spec.surface === "public") || requiredNames.has(view.metadata.name),
    ));
    const viewNames = new Set(views.map((view) => view.metadata.name));
    const missingRequiredViews = [...requiredNames]
      .filter((name) => !viewNames.has(name))
      .sort();
    const sqliteVersion = db.prepare("SELECT sqlite_version() AS version")
      .get() as { readonly version: string };

    return {
      version: 1,
      sqliteVersion: sqliteVersion.version,
      rowsPerSchema,
      paths,
      summary: {
        views: paths.length,
        required: paths.filter((path) => path.required).length + missingRequiredViews.length,
        requiredFailures:
          paths.filter((path) => path.required && !path.passed).length +
          missingRequiredViews.length,
        missingRequiredViews,
        tableScans: paths.filter((path) => path.tableScan).length,
        temporarySorts: paths.filter((path) => path.temporarySort).length,
      },
    };
  } finally {
    db.close();
  }
}

function inspectView(
  db: DatabaseSync,
  view: ViewManifest,
  runtimePlan: RuntimePlan,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
  explicitlyRequired: boolean,
): IndexCoveragePath {
  const params = sampleParams(view);
  const compiled = view.spec.select
    ? compileStoreView(view, runtimePlan, schemasByName, params)
    : compileView(view, { params, page: 1, ctxUserId: "index-harness-user" }, view.spec.from ? schemasByName.get(view.spec.from) : undefined);
  const sqliteParams = compiled.params.map(toSqliteValue);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
    .all(...sqliteParams) as unknown as QueryPlanRow[])
    .map(({ detail }) => detail);
  const rows = db.prepare(compiled.sql).all(...sqliteParams);
  const usedIndexes = [...new Set(plan.flatMap(indexFromPlan))];
  const tableAccess = plan.filter((detail) => /\b(?:SCAN|SEARCH)\b/.test(detail));
  const tableScan = tableAccess.some(
    (detail) => !/\bUSING (?:COVERING )?INDEX\b/.test(detail),
  );
  const indexedScan = tableAccess.some(
    (detail) => /\bUSING (?:COVERING )?INDEX\b/.test(detail),
  );
  const temporarySort = plan.some((detail) => /USE TEMP B-TREE.*ORDER BY/.test(detail));
  const accessFields = [...dataAccessFields(view)].sort();
  const filterFields = [...dataFilterFields(view)].sort();
  const usedSchemaFields = new Set(
    usedIndexes.flatMap((name) => indexFields(db, name)),
  );
  const schemaIndexRequired = accessFields.length > 0;
  const schemaIndexUsed = schemaIndexRequired &&
    accessFields.every((field) => usedSchemaFields.has(field));
  const findings: string[] = [];
  if (tableScan) findings.push("full table scan");
  if (
    indexedScan &&
    filterFields.length > 0 &&
    !plan.some((detail) => /\bSEARCH\b/.test(detail))
  ) {
    findings.push("data-field filter scans an index without a searchable prefix");
  }
  if (temporarySort) findings.push("temporary ORDER BY B-tree");
  if (schemaIndexRequired && !schemaIndexUsed) {
    findings.push("data-field predicates/order do not use a declared Schema index");
  }
  return {
    view: view.metadata.name,
    schema: view.spec.select?.from ?? view.spec.from ?? "(sql)",
    surface: view.spec.surface,
    required: explicitlyRequired,
    sql: compiled.sql,
    params: compiled.params,
    plan,
    usedIndexes,
    resultCount: rows.length,
    tableScan,
    indexedScan,
    temporarySort,
    dataAccessFields: accessFields,
    schemaIndexRequired,
    schemaIndexUsed,
    passed: findings.length === 0,
    findings,
  };
}

function compileStoreView(
  view: ViewManifest,
  plan: RuntimePlan,
  schemas: ReadonlyMap<string, SchemaManifest>,
  params: Record<string, unknown>,
): { readonly sql: string; readonly params: readonly unknown[] } {
  const selected = bindStoreViewSelect(
    view, plan.views[view.metadata.name], { params }, params,
    { user: { id: "index-harness-user" }, staff: null, env: {} },
    `manifest:View/${view.metadata.name}`, Date.now, schemas,
  );
  const compiler = new SqliteStoreQueryCompiler(schemas, (table) => liveTtlCondition(table.schema, Date.now));
  const table = compiler.table(selected.from);
  const where = compiler.where(table, scopeStoreWhere(selected.where, table.schema, schemas, "index-harness-user"));
  const [sortField, direction] = Object.entries(selected.orderBy ?? { updatedAt: "desc" })[0]!;
  const sort = compiler.orderColumn(table, sortField);
  const nulls = direction === "asc" && !["id", "status", "version", "createdAt", "updatedAt"].includes(sortField) ? " NULLS LAST" : "";
  return {
    sql: `SELECT ${table.selectColumns} FROM ${table.table} WHERE ${where.sql} ORDER BY ${sort} ${direction.toUpperCase()}${nulls}, "_mantle_id" ${direction.toUpperCase()} LIMIT ?`,
    params: [...where.binds, (selected.limit ?? 50) + 1],
  };
}

function indexFields(db: DatabaseSync, name: string): readonly string[] {
  return (db.prepare(`PRAGMA index_info(${quoteIdent(name)})`).all() as Array<{ readonly name: string }>)
    .map((row) => row.name);
}

function seedSchemas(
  db: DatabaseSync,
  schemas: readonly SchemaManifest[],
  rowsPerSchema: number,
): void {
  for (const schema of schemas) {
    const operational = resolveLifecycle(schema) === "operational";
    const fields = Object.keys(schema.spec.schema.properties ?? {});
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${quoteIdent(schema.metadata.name)}
       (${["_mantle_id", "_mantle_status", "_mantle_version", "_mantle_author_id", "_mantle_created_at", "_mantle_updated_at", ...fields].map(quoteIdent).join(", ")})
       VALUES (${Array.from({ length: 6 + fields.length }, () => "?").join(", ")})`,
    );
    const singleUnique = new Set(
      (schema.spec.uniqueIndexes ?? [])
        .filter((fields) => fields.length === 1)
        .map((fields) => fields[0]!),
    );
    for (let index = 0; index < rowsPerSchema; index += 1) {
      const data = sampleData(schema, index, singleUnique);
      insert.run(
        `${schema.metadata.name}-${index}`,
        operational || index % 5 === 0 ? "published" : "draft",
        1,
        null,
        index,
        index,
        ...fields.map((field) => toSqliteValue(data[field])),
      );
    }
  }
}

function sampleData(
  schema: SchemaManifest,
  index: number,
  singleUnique: ReadonlySet<string>,
): Record<string, unknown> {
  const jsonSchema = schema.spec.schema as { readonly properties?: Record<string, unknown> };
  const data: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(jsonSchema.properties ?? {})) {
    if (field === "locale" && !singleUnique.has(field)) {
      data[field] = index % 20 === 0 ? null : index % 4 === 0 ? "zh-TW" : "en";
    } else {
      data[field] = sampleProperty(field, raw, index, singleUnique.has(field));
    }
  }
  return data;
}

function sampleParams(view: ViewManifest): Record<string, unknown> {
  const schema = view.spec.params as { readonly properties?: Record<string, unknown> } | undefined;
  return Object.fromEntries(
    Object.entries(schema?.properties ?? {}).map(([name, raw]) => [
      name,
      sampleProperty(name, raw, 1, false),
    ]),
  );
}

function sampleProperty(
  field: string,
  raw: unknown,
  index: number,
  singleUnique: boolean,
): unknown {
  const property = isRecord(raw) ? raw : {};
  const rawType = property["type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const type = types.find((candidate) => candidate !== "null");
  if (type === "integer" || type === "number") return index + 1;
  if (type === "boolean") return singleUnique && index > 1 ? null : index % 2 === 0;
  if (type === "array") return [];
  if (type === "object") return {};
  return `${field}-${index}`;
}

function dataAccessFields(view: ViewManifest): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const field of Object.keys(view.spec.select?.orderBy ?? {})) addDataField(fields, field);
  if (view.spec.select?.where) collectStoreFields(view.spec.select.where, fields);
  for (const item of view.spec.orderBy ?? []) addDataField(fields, item.field);
  if (view.spec.filter) collectFilterFields(view.spec.filter, fields);
  return fields;
}

function dataFilterFields(view: ViewManifest): ReadonlySet<string> {
  const fields = new Set<string>();
  if (view.spec.select?.where) collectStoreFields(view.spec.select.where, fields);
  if (view.spec.filter) collectFilterFields(view.spec.filter, fields);
  return fields;
}

function collectStoreFields(where: Readonly<Record<string, unknown>>, fields: Set<string>): void {
  for (const [field, value] of Object.entries(where)) {
    if (field === "and" || field === "or") {
      for (const child of value as readonly Readonly<Record<string, unknown>>[]) collectStoreFields(child, fields);
    } else if (field === "not") collectStoreFields(value as Readonly<Record<string, unknown>>, fields);
    else addDataField(fields, field);
  }
}

function collectFilterFields(node: FilterAst, fields: Set<string>): void {
  const comparison = "eq" in node ? node.eq
    : "gt" in node ? node.gt
    : "gte" in node ? node.gte
    : "lt" in node ? node.lt
    : "lte" in node ? node.lte
    : null;
  if (comparison) {
    addDataField(fields, comparison.field);
    return;
  }
  const children = "and" in node ? node.and : "or" in node ? node.or : [];
  for (const child of children) collectFilterFields(child, fields);
}

function addDataField(fields: Set<string>, field: string): void {
  if (!(RESERVED_ENTRY_COLUMNS as readonly string[]).includes(field)) fields.add(field);
}

function indexFromPlan(detail: string): string[] {
  const match = detail.match(/USING (?:COVERING )?INDEX ([^ ]+)/);
  return match?.[1] ? [match[1]] : [];
}

function toSqliteValue(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function clampRows(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 2_000;
  return Math.min(20_000, Math.max(100, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
