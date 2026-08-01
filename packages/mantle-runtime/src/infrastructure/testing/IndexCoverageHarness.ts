import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  RESERVED_ENTRY_COLUMNS,
  buildDdl,
  partitionManifests,
  type FilterAst,
  type Manifest,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import { compileView } from "../../domain/service/ViewSqlCompiler.js";
import { CANONICAL_MIGRATIONS } from "../boot/canonicalMigrations.js";

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
  manifests: readonly Manifest[],
  options: IndexCoverageOptions = {},
): IndexCoverageReport {
  const rowsPerSchema = clampRows(options.rowsPerSchema);
  const requiredNames = new Set(options.requiredViews ?? []);
  const { schemas, views } = partitionManifests([...manifests]);
  const schemasByName = new Map(schemas.map((schema) => [schema.metadata.name, schema]));
  const db = new DatabaseSync(":memory:");

  try {
    for (const migration of CANONICAL_MIGRATIONS) db.exec(migration.sql);
    for (const schema of schemas) {
      const ddl = buildDdl(schema);
      for (const column of ddl.columns) db.exec(column.sql);
      for (const index of ddl.indexes) db.exec(index.sql);
    }
    seedSchemas(db, schemas, rowsPerSchema);
    db.exec("ANALYZE");

    const paths = views.map((view) => inspectView(
      db,
      view,
      schemasByName.get(view.spec.from),
      (options.requirePublic === true && view.spec.surface !== "staff") ||
        requiredNames.has(view.metadata.name),
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
  schema: SchemaManifest | undefined,
  explicitlyRequired: boolean,
): IndexCoveragePath {
  const params = sampleParams(view);
  const compiled = compileView(view, { params, page: 1 }, schema);
  const sqliteParams = compiled.params.map(toSqliteValue);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
    .all(...sqliteParams) as unknown as QueryPlanRow[])
    .map(({ detail }) => detail);
  const rows = db.prepare(compiled.sql).all(...sqliteParams);
  const usedIndexes = [...new Set(plan.flatMap(indexFromPlan))];
  const entryScans = plan.filter((detail) => /\bSCAN entries\b/.test(detail));
  const tableScan = entryScans.some(
    (detail) => !/\bUSING (?:COVERING )?INDEX\b/.test(detail),
  );
  const indexedScan = entryScans.some(
    (detail) => /\bUSING (?:COVERING )?INDEX\b/.test(detail),
  );
  const temporarySort = plan.some((detail) => /USE TEMP B-TREE FOR ORDER BY/.test(detail));
  const accessFields = [...dataAccessFields(view)].sort();
  const filterFields = [...dataFilterFields(view)].sort();
  const schemaIndexFields = declaredIndexFields(schema);
  const usedSchemaFields = new Set(
    usedIndexes.flatMap((name) => schemaIndexFields.get(name) ?? []),
  );
  const schemaIndexRequired = accessFields.length > 0;
  const schemaIndexUsed = schemaIndexRequired &&
    accessFields.every((field) => usedSchemaFields.has(field));
  const findings: string[] = [];
  if (tableScan) findings.push("full entries scan");
  if (
    indexedScan &&
    filterFields.length > 0 &&
    !plan.some((detail) => /\bSEARCH entries\b/.test(detail))
  ) {
    findings.push("data-field filter scans an index without a searchable prefix");
  }
  if (temporarySort) findings.push("temporary ORDER BY B-tree");
  if (schemaIndexRequired && !schemaIndexUsed) {
    findings.push("data-field predicates/order do not use a declared Schema index");
  }
  return {
    view: view.metadata.name,
    schema: view.spec.from,
    surface: view.spec.surface ?? "public",
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

function declaredIndexFields(
  schema: SchemaManifest | undefined,
): ReadonlyMap<string, readonly string[]> {
  if (!schema) return new Map();
  const declarations = [
    ...(schema.spec.uniqueIndexes ?? []),
    ...(schema.spec.indexes ?? []),
  ];
  return new Map(
    buildDdl(schema).indexes.map((index, position) => [
      index.name,
      declarations[position] ?? [],
    ]),
  );
}

function seedSchemas(
  db: DatabaseSync,
  schemas: readonly SchemaManifest[],
  rowsPerSchema: number,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO entries
     (id, collection, status, version, data, author_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, NULL, ?, ?)`,
  );
  for (const schema of schemas) {
    const singleUnique = new Set(
      (schema.spec.uniqueIndexes ?? [])
        .filter((fields) => fields.length === 1)
        .map((fields) => fields[0]!),
    );
    for (let index = 0; index < rowsPerSchema; index += 1) {
      insert.run(
        `${schema.metadata.name}-${index}`,
        schema.metadata.name,
        index % 5 === 0 ? "published" : "draft",
        JSON.stringify(sampleData(schema, index, singleUnique)),
        index,
        index,
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
  for (const item of view.spec.orderBy ?? []) addDataField(fields, item.field);
  if (view.spec.filter) collectFilterFields(view.spec.filter, fields);
  return fields;
}

function dataFilterFields(view: ViewManifest): ReadonlySet<string> {
  const fields = new Set<string>();
  if (view.spec.filter) collectFilterFields(view.spec.filter, fields);
  return fields;
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
