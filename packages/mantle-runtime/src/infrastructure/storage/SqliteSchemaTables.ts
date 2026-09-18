import {
  checkSchemaIndexes,
  type JsonSchema,
  type SchemaManifest,
} from "@aotter/mantle-spec";
import type { Migration } from "../../domain/port/DatabaseDriver.js";

const SYSTEM_COLUMNS = ["_mantle_id", "_mantle_status", "_mantle_version", "_mantle_author_id", "_mantle_created_at", "_mantle_updated_at"] as const;
const MAX_D1_COLUMNS = 100;

export interface SqliteSchemaTable {
  readonly schema: SchemaManifest;
  readonly table: string;
  readonly fields: readonly string[];
  readonly selectColumns: string;
}

interface SchemaTableProjection {
  readonly columns: readonly (readonly [name: string, affinity: "TEXT" | "INTEGER" | "REAL"])[];
  readonly indexes: readonly (readonly [unique: boolean, fields: readonly string[], relationship: boolean])[];
}

export function sqliteSchemaTable(schema: SchemaManifest): SqliteSchemaTable {
  const fields = Object.keys(schema.spec.schema.properties ?? {});
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

export function schemaTableMigrations(schemas: Iterable<SchemaManifest>): readonly Migration[] {
  const migrations: Migration[] = [];
  for (const schema of [...schemas].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    const table = sqliteSchemaTable(schema);
    migrations.push({
      id: `schema-table-v1:table:${utf8Hex(schema.metadata.name)}`,
      description: `Native table for Schema ${schema.metadata.name}`,
      sql: `CREATE TABLE ${table.table} (
        "_mantle_id" TEXT PRIMARY KEY,
        "_mantle_status" TEXT NOT NULL,
        "_mantle_version" INTEGER NOT NULL DEFAULT 1,
        "_mantle_author_id" TEXT,
        "_mantle_created_at" INTEGER NOT NULL,
        "_mantle_updated_at" INTEGER NOT NULL
      ); INSERT INTO _mantle_schema_tables(name, projection) VALUES (${quoteText(schema.metadata.name)}, ${quoteText(schemaTableProjection(schema))})`,
    });
    for (const field of table.fields) {
      const property = schema.spec.schema.properties![field]!;
      migrations.push({
        id: `schema-table-v1:column:${utf8Hex(schema.metadata.name)}:${utf8Hex(field)}`,
        description: `Schema ${schema.metadata.name} field ${field}`,
        sql: `ALTER TABLE ${table.table} ADD COLUMN ${quoteIdent(field)} ${fieldAffinity(property)}`,
      });
    }
    migrations.push({
      id: `schema-table-v1:index:${utf8Hex(schema.metadata.name)}:updated`,
      description: `Schema ${schema.metadata.name} updated-at access path`,
      sql: `CREATE INDEX ${quoteIdent(indexName(schema.metadata.name, "updated"))} ON ${table.table}("_mantle_updated_at" DESC, "_mantle_id" DESC)`,
    });
    migrations.push({
      id: `schema-table-v1:index:${utf8Hex(schema.metadata.name)}:status-updated`,
      description: `Schema ${schema.metadata.name} status access path`,
      sql: `CREATE INDEX ${quoteIdent(indexName(schema.metadata.name, "status_updated"))} ON ${table.table}("_mantle_status", "_mantle_updated_at" DESC, "_mantle_id" DESC)`,
    });
    migrations.push({
      id: `schema-table-v1:index:${utf8Hex(schema.metadata.name)}:created`,
      description: `Schema ${schema.metadata.name} creation statistics access path`,
      sql: `CREATE INDEX ${quoteIdent(indexName(schema.metadata.name, "created"))} ON ${table.table}("_mantle_created_at")`,
    });
    const checked = checkSchemaIndexes(schema);
    const problem = checked.problems[0];
    if (problem) throw new Error(`invalid Schema index declaration at ${problem.pointer}: ${problem.message}`);
    for (const declaration of checked.declarations) {
      const fields = declaration.fields.map(({ name }) => quoteIdent(name));
      const relationship = !declaration.unique && declaration.fields.length === 1 &&
        (schema.spec.translates?.on === declaration.fields[0]!.name ||
          typeof schema.spec.schema.properties?.[declaration.fields[0]!.name]?.["x-mantle-ref"] === "string");
      if (relationship) fields.push('"_mantle_updated_at" DESC', '"_mantle_id" DESC');
      const suffix = `${declaration.unique ? "unique" : relationship ? "relation" : "index"}_${declaration.fields.map(({ name }) => utf8Hex(name)).join("_")}`;
      migrations.push({
        id: `schema-table-v1:index:${utf8Hex(schema.metadata.name)}:${suffix}`,
        description: `Schema ${schema.metadata.name} ${declaration.unique ? "unique " : ""}index`,
        sql: `CREATE ${declaration.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(indexName(schema.metadata.name, suffix))} ON ${table.table}(${fields.join(", ")})`,
      });
    }
  }
  return migrations;
}

export function schemaTableProjection(schema: SchemaManifest): string {
  const checked = checkSchemaIndexes(schema);
  const problem = checked.problems[0];
  if (problem) throw new Error(`invalid Schema index declaration at ${problem.pointer}: ${problem.message}`);
  const projection: SchemaTableProjection = {
    columns: Object.entries(schema.spec.schema.properties ?? {}).map(([name, property]) => [name, fieldAffinity(property)]),
    indexes: checked.declarations.map((declaration) => [
      declaration.unique,
      declaration.fields.map(({ name }) => name),
      !declaration.unique && declaration.fields.length === 1 &&
        (schema.spec.translates?.on === declaration.fields[0]!.name ||
          typeof schema.spec.schema.properties?.[declaration.fields[0]!.name]?.["x-mantle-ref"] === "string"),
    ]),
  };
  return JSON.stringify(projection);
}

export function isAdditiveSchemaTableChange(previous: string, next: string): boolean {
  const before = JSON.parse(previous) as SchemaTableProjection;
  const after = JSON.parse(next) as SchemaTableProjection;
  const columns = new Map(after.columns);
  return before.columns.every(([name, affinity]) => columns.get(name) === affinity) &&
    before.indexes.every((index) => after.indexes.some((candidate) => JSON.stringify(candidate) === JSON.stringify(index)));
}

export function fieldSql(schema: SchemaManifest, field: string, alias?: string): string | null {
  const native = Object.hasOwn(schema.spec.schema.properties ?? {}, field) ? field
    : field === "id" ? "_mantle_id"
      : field === "status" ? "_mantle_status"
        : field === "version" ? "_mantle_version"
          : field === "createdAt" ? "_mantle_created_at"
            : field === "updatedAt" ? "_mantle_updated_at"
              : field === "authorId" ? "_mantle_author_id" : null;
  if (!native) return null;
  return alias ? `${quoteIdent(alias)}.${quoteIdent(native)}` : quoteIdent(native);
}

export function encodeField(value: unknown, property: JsonSchema): unknown {
  if (value == null) return null;
  const type = nonNullType(property);
  if (type === "boolean") return value ? 1 : 0;
  if (type === "object" || type === "array" || type === null) return JSON.stringify(value);
  return value;
}

export function decodeField(value: unknown, property: JsonSchema): unknown {
  if (value === null) {
    const types = typeof property.type === "string" ? [property.type] : property.type ?? [];
    return types.includes("null") ? null : undefined;
  }
  if (value === undefined) return undefined;
  const type = nonNullType(property);
  if (type === "boolean") return value === 1 || value === true;
  if ((type === "object" || type === "array" || type === null) && typeof value === "string") return JSON.parse(value);
  return value;
}

function fieldAffinity(property: JsonSchema): "TEXT" | "INTEGER" | "REAL" {
  switch (nonNullType(property)) {
    case "integer":
    case "boolean":
      return "INTEGER";
    case "number":
      return "REAL";
    default:
      return "TEXT";
  }
}

function nonNullType(property: JsonSchema): string | null {
  const types = typeof property.type === "string" ? [property.type] : property.type ?? [];
  return types.find((type) => type !== "null") ?? null;
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

function quoteText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
