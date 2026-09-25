import {
  checkSchemaIndexes,
  resolveMantleRef,
  type JsonSchema,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import { isNullableJsonSchema } from "../../domain/model/EntryRow.js";
import type { Migration } from "../../domain/port/DatabaseDriver.js";

export { isNullableJsonSchema };

const SYSTEM_COLUMNS = ["_mantle_id", "_mantle_status", "_mantle_version", "_mantle_author_id", "_mantle_created_at", "_mantle_updated_at"] as const;
const RESERVED_TABLES = new Set([
  "entries", "_migrations", "d1_migrations", "_mantle_boot_state", "_mantle_schema_tables", "_mantle_storage_state", "_mantle_managed_runtime_state",
  "site_config", "sites_users", "user", "session", "account", "verification", "jwks", "oauthclient",
  "oauthresource", "oauthclientresource", "oauthrefreshtoken", "oauthaccesstoken", "oauthconsent",
  "oauthclientassertion", "media_assets", "pending_media_uploads",
]);
const MAX_D1_COLUMNS = 100;

type SqliteAffinity = "TEXT" | "INTEGER" | "REAL";
type FieldCodec = "string" | "integer" | "number" | "boolean" | "json";
type ColumnProjection = readonly [name: string, affinity: SqliteAffinity, codec: FieldCodec, nullable: boolean];
type IndexProjection = readonly [unique: boolean, fields: readonly string[], relationship: boolean];

export interface SqliteSchemaTable {
  readonly schema: SchemaManifest;
  readonly table: string;
  readonly fields: readonly string[];
  readonly selectColumns: string;
}

interface SchemaTableProjection {
  readonly columns: readonly ColumnProjection[];
  readonly indexes: readonly IndexProjection[];
}

export function sqliteSchemaTable(schema: SchemaManifest): SqliteSchemaTable {
  assertTableName(schema.metadata.name);
  const fields = Object.keys(schema.spec.schema.properties ?? {}).sort(compareText);
  const seen = new Set(SYSTEM_COLUMNS.map((name) => name.toLowerCase()));
  for (const field of fields) {
    const folded = field.toLowerCase();
    if (folded.startsWith("_mantle_") || seen.has(folded)) {
      throw new Error(`Schema '${schema.metadata.name}' field '${field}' uses Mantle's reserved SQLite namespace.`);
    }
    seen.add(folded);
  }
  if (fields.length + SYSTEM_COLUMNS.length > MAX_D1_COLUMNS) {
    throw new Error(`Schema '${schema.metadata.name}' exceeds D1's ${MAX_D1_COLUMNS}-column table limit.`);
  }
  return {
    schema,
    table: quoteIdent(schema.metadata.name),
    fields,
    selectColumns: [...SYSTEM_COLUMNS.map(quoteIdent), ...fields.map(quoteIdent)].join(", "),
  };
}

export function validateSqliteSchemaTables(schemas: Iterable<SchemaManifest>): readonly SchemaManifest[] {
  const sorted = [...schemas].sort((a, b) => compareText(a.metadata.name, b.metadata.name));
  const seen = new Map<string, string>();
  for (const schema of sorted) {
    sqliteSchemaTable(schema);
    const folded = schema.metadata.name.toLowerCase();
    const previous = seen.get(folded);
    if (previous) throw new Error(`Schema names '${previous}' and '${schema.metadata.name}' collide in SQLite.`);
    seen.set(folded, schema.metadata.name);
  }
  return sorted;
}

export function schemaTableMigrations(schemas: Iterable<SchemaManifest>): readonly Migration[] {
  const migrations: Migration[] = [];
  for (const schema of validateSqliteSchemaTables(schemas)) {
    const table = sqliteSchemaTable(schema);
    migrations.push({
      id: `schema-table-v2:table:${utf8Hex(schema.metadata.name)}`,
      description: `Native table for Schema ${schema.metadata.name}`,
      sql: `CREATE TABLE IF NOT EXISTS ${table.table} (
        "_mantle_id" TEXT PRIMARY KEY,
        "_mantle_status" TEXT NOT NULL,
        "_mantle_version" INTEGER NOT NULL DEFAULT 1,
        "_mantle_author_id" TEXT,
        "_mantle_created_at" INTEGER NOT NULL,
        "_mantle_updated_at" INTEGER NOT NULL
      )`,
    });
    for (const field of table.fields) {
      const property = schema.spec.schema.properties![field]!;
      migrations.push({
        id: `schema-table-v2:column:${utf8Hex(schema.metadata.name)}:${utf8Hex(field)}`,
        description: `Schema ${schema.metadata.name} field ${field}`,
        sql: `ALTER TABLE ${table.table} ADD COLUMN ${quoteIdent(field)} ${fieldDescriptor(property)[0]}`,
      });
    }
    migrations.push({
      id: `schema-table-v2:index:${utf8Hex(schema.metadata.name)}:updated`,
      description: `Schema ${schema.metadata.name} updated-at access path`,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName(schema.metadata.name, "updated"))} ON ${table.table}("_mantle_updated_at" DESC, "_mantle_id" DESC)`,
    });
    migrations.push({
      id: `schema-table-v2:index:${utf8Hex(schema.metadata.name)}:status-updated`,
      description: `Schema ${schema.metadata.name} status access path`,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName(schema.metadata.name, "status_updated"))} ON ${table.table}("_mantle_status", "_mantle_updated_at" DESC, "_mantle_id" DESC)`,
    });
    migrations.push({
      id: `schema-table-v2:index:${utf8Hex(schema.metadata.name)}:created`,
      description: `Schema ${schema.metadata.name} creation statistics access path`,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName(schema.metadata.name, "created"))} ON ${table.table}("_mantle_created_at")`,
    });
    if (table.fields.includes("locale")) {
      migrations.push({
        id: `schema-table-v2:index:${utf8Hex(schema.metadata.name)}:locale-status-updated`,
        description: `Schema ${schema.metadata.name} localized publication access path`,
        sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName(schema.metadata.name, "locale_status_updated"))} ON ${table.table}(${quoteIdent("locale")}, "_mantle_status", "_mantle_updated_at" DESC, "_mantle_id" DESC)`,
      });
    }
    const checked = checkSchemaIndexes(schema);
    const problem = checked.problems[0];
    if (problem) throw new Error(`invalid Schema index declaration at ${problem.pointer}: ${problem.message}`);
    for (const declaration of checked.declarations) {
      // Native columns (`status`, `createdAt`, …) map to their `_mantle_*` column (#1008).
      const fields = declaration.fields.map(({ name }) => quoteIdent(NATIVE_COLUMN[name] ?? name));
      const relationship = !declaration.unique && declaration.fields.length === 1 &&
        (schema.spec.translates?.on === declaration.fields[0]!.name ||
          resolveMantleRef(schema.spec.schema.properties?.[declaration.fields[0]!.name]) !== null);
      if (relationship) fields.push('"_mantle_updated_at" DESC', '"_mantle_id" DESC');
      const suffix = `${declaration.unique ? "unique" : relationship ? "relation" : "index"}_${declaration.fields.map(({ name }) => utf8Hex(name)).join("_")}`;
      migrations.push({
        id: `schema-table-v2:index:${utf8Hex(schema.metadata.name)}:${suffix}`,
        description: `Schema ${schema.metadata.name} ${declaration.unique ? "unique " : ""}index`,
        sql: `CREATE ${declaration.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(indexName(schema.metadata.name, suffix))} ON ${table.table}(${fields.join(", ")})`,
      });
    }
  }
  return migrations;
}

export function schemaTableProjection(schema: SchemaManifest): string {
  sqliteSchemaTable(schema);
  const checked = checkSchemaIndexes(schema);
  const problem = checked.problems[0];
  if (problem) throw new Error(`invalid Schema index declaration at ${problem.pointer}: ${problem.message}`);
  const projection: SchemaTableProjection = {
    columns: Object.entries(schema.spec.schema.properties ?? {})
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, property]) => [name, ...fieldDescriptor(property)]),
    indexes: checked.declarations.map((declaration): IndexProjection => [
      declaration.unique,
      declaration.fields.map(({ name }) => name),
      !declaration.unique && declaration.fields.length === 1 &&
        (schema.spec.translates?.on === declaration.fields[0]!.name ||
          resolveMantleRef(schema.spec.schema.properties?.[declaration.fields[0]!.name]) !== null),
    ]).sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
  };
  return JSON.stringify(projection);
}

/** Automatic deploys may expand storage but never reinterpret values or alter uniqueness. */
export function isAdditiveSchemaTableChange(previous: string, next: string): boolean {
  const before = parseProjection(previous);
  const after = parseProjection(next);
  const beforeColumns = new Map(before.columns.map((column) => [column[0].toLowerCase(), column]));
  for (const column of after.columns) {
    const existing = beforeColumns.get(column[0].toLowerCase());
    if (existing && JSON.stringify(existing) !== JSON.stringify(column)) return false;
  }
  const uniqueBefore = new Set(before.indexes.filter(([unique]) => unique).map(indexKey));
  const uniqueAfter = new Set(after.indexes.filter(([unique]) => unique).map(indexKey));
  return setsEqual(uniqueBefore, uniqueAfter);
}

/** A managed database may serve an older plan only when its stored table is an additive superset. */
export function coversSchemaTableProjection(expected: string, actual: string): boolean {
  const want = parseProjection(expected);
  const have = parseProjection(actual);
  const columns = new Map(have.columns.map((column) => [column[0].toLowerCase(), column]));
  if (want.columns.some((column) => JSON.stringify(columns.get(column[0].toLowerCase())) !== JSON.stringify(column))) return false;
  return setsEqual(
    new Set(want.indexes.filter(([unique]) => unique).map(indexKey)),
    new Set(have.indexes.filter(([unique]) => unique).map(indexKey)),
  );
}

/** Persist physical ownership as a superset so an additive rollback remains valid. */
export function mergeSchemaTableProjections(previous: string | undefined, next: string): string {
  if (!previous) return next;
  if (!isAdditiveSchemaTableChange(previous, next)) throw new Error("Schema table projection requires reviewed migration.");
  const before = parseProjection(previous);
  const after = parseProjection(next);
  const columns = new Map(before.columns.map((column) => [column[0].toLowerCase(), column]));
  for (const column of after.columns) columns.set(column[0].toLowerCase(), column);
  const indexes = new Map(before.indexes.map((index) => [indexKey(index), index]));
  for (const index of after.indexes) indexes.set(indexKey(index), index);
  return JSON.stringify({
    columns: [...columns.values()].sort((a, b) => compareText(a[0], b[0])),
    indexes: [...indexes.values()].sort((a, b) => compareText(indexKey(a), indexKey(b))),
  } satisfies SchemaTableProjection);
}

/** Logical entry column name → physical SQLite column. The parser rejects
 *  data properties with these names, so the mapping never shadows data. */
export const NATIVE_COLUMN: Readonly<Record<string, string>> = Object.freeze({
  id: "_mantle_id",
  status: "_mantle_status",
  version: "_mantle_version",
  createdAt: "_mantle_created_at",
  updatedAt: "_mantle_updated_at",
  authorId: "_mantle_author_id",
});

export function fieldColumn(schema: SchemaManifest, field: string): string | null {
  const native = NATIVE_COLUMN[field];
  if (native) return native;
  return Object.hasOwn(schema.spec.schema.properties ?? {}, field) ? field : null;
}

export function fieldSql(schema: SchemaManifest, field: string, alias?: string): string | null {
  const native = fieldColumn(schema, field);
  if (!native) return null;
  return alias ? `${quoteIdent(alias)}.${quoteIdent(native)}` : quoteIdent(native);
}

export function encodeField(value: unknown, property: JsonSchema): unknown {
  if (value == null) return null;
  const codec = fieldDescriptor(property)[1];
  if (codec === "boolean") return value ? 1 : 0;
  if (codec === "json") return JSON.stringify(value);
  return value;
}

export function decodeField(value: unknown, property: JsonSchema): unknown {
  if (value === null) return fieldDescriptor(property)[2] ? null : undefined;
  if (value === undefined) return undefined;
  const codec = fieldDescriptor(property)[1];
  if (codec === "boolean") return value === 1 || value === true;
  if (codec === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("Invalid JSON for a native Schema field.");
    }
  }
  return value;
}

function fieldDescriptor(property: JsonSchema): readonly [SqliteAffinity, FieldCodec, boolean] {
  const types = [...new Set((typeof property.type === "string" ? [property.type] : property.type ?? []).filter((type) => type !== "null"))];
  const type = types.length === 1 && !property.oneOf ? types[0] : undefined;
  const codec: FieldCodec = type === "string" || type === "integer" || type === "number" || type === "boolean" ? type : "json";
  const affinity: SqliteAffinity = codec === "integer" || codec === "boolean" ? "INTEGER" : codec === "number" ? "REAL" : "TEXT";
  return [affinity, codec, isNullableJsonSchema(property)];
}

function parseProjection(value: string): SchemaTableProjection {
  const parsed = JSON.parse(value) as Partial<SchemaTableProjection>;
  if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.indexes)) throw new Error("Invalid Schema table projection.");
  return parsed as SchemaTableProjection;
}

function assertTableName(name: string): void {
  const folded = name.toLowerCase();
  if (folded.startsWith("_mantle_") || RESERVED_TABLES.has(folded)) {
    throw new Error(`Schema '${name}' collides with a reserved SQLite table.`);
  }
}

function indexKey(index: IndexProjection): string {
  return JSON.stringify(index);
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function indexName(schema: string, suffix: string): string {
  return `m_${utf8Hex(schema)}_${suffix}`;
}

function utf8Hex(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
/** Below SQLite's supported date range, no stored date can have expired. */
export function ttlCutoff(now: number, seconds: number): string | null {
  const cutoff = now - seconds * 1000;
  return cutoff < Date.parse("0000-01-01T00:00:00.000Z") ? null : new Date(cutoff).toISOString();
}
