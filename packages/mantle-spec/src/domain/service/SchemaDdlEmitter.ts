import {
  MANTLE_REF_KEYWORD,
  RESERVED_ENTRY_COLUMNS,
  type ReservedEntryColumn,
  type SchemaManifest,
} from "../model/ManifestGrammar.js";
import {
  checkSchemaIndexes,
  type ResolvedSchemaIndexField,
} from "./SchemaIndexChecker.js";

/** Pure Schema-manifest → SQLite DDL output; runtime owns execution. */
export interface DdlStatements {
  readonly columns: readonly {
    readonly name: string;
    readonly sql: string;
  }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly sql: string;
  }[];
}

export interface SchemaSqlViewDdl {
  readonly name: string;
  readonly createSql: string;
  readonly dropSql: string;
}

const ENTRY_COLUMN: Readonly<Record<ReservedEntryColumn, string>> = {
  id: "id",
  status: "status",
  version: "version",
  createdAt: "created_at",
  updatedAt: "updated_at",
  authorId: "author_id",
};

/** Expose a Schema as a read-only SQLite table for SQL-first Views. */
export function buildSchemaSqlView(manifest: SchemaManifest): SchemaSqlViewDdl {
  const propertyNames = Object.keys(manifest.spec.schema.properties ?? {});
  const propertySet = new Set(propertyNames);
  const platformColumns = RESERVED_ENTRY_COLUMNS
    .filter((name) => !propertySet.has(name))
    .map((name) => `${quoteIdent(ENTRY_COLUMN[name])} AS ${quoteIdent(name)}`);
  const dataColumns = propertyNames.map((name) => {
    if (/["\\\0]/.test(name)) {
      throw new Error(`Schema '${manifest.metadata.name}' field '${name}' cannot be represented as a SQLite JSON path.`);
    }
    return `json_extract(data, ${quoteText(jsonPath(name))}) AS ${quoteIdent(name)}`;
  });
  const name = manifest.metadata.name;
  return {
    name,
    createSql:
      `CREATE VIEW ${quoteIdent(name)} AS SELECT ${[...platformColumns, ...dataColumns].join(", ")} ` +
      `FROM entries WHERE collection = ${quoteText(name)}`,
    dropSql: dropSchemaSqlViewSql(name),
  };
}

export function dropSchemaSqlViewSql(name: string): string {
  return `DROP VIEW IF EXISTS ${quoteIdent(name)}`;
}

/**
 * Build generated columns and ordered composite indexes for one Schema.
 * Both declaration kinds share the same validated fields and columns.
 */
export function buildDdl(manifest: SchemaManifest): DdlStatements {
  const checked = checkedIndexes(manifest);
  const columns = new Map<string, DdlStatements["columns"][number]>();
  const indexes: Array<DdlStatements["indexes"][number]> = [];

  for (const declaration of checked.declarations) {
    const relationOrdered = !declaration.unique &&
      declaration.fields.length === 1 &&
      isRelationshipField(manifest, declaration.fields[0]!.name);
    const columnNames = declaration.fields.map((field) => {
      const name = generatedColumnName(manifest.metadata.name, field);
      if (!columns.has(name)) {
        columns.set(name, {
          name,
          sql:
            `ALTER TABLE entries ADD COLUMN ${quoteIdent(name)} ${field.affinity} ` +
            `GENERATED ALWAYS AS (` +
            `CASE WHEN collection = ${quoteText(manifest.metadata.name)} ` +
            `THEN json_extract(data, ${quoteText(jsonPath(field.name))}) END` +
            `) VIRTUAL`,
        });
      }
      return name;
    });
    const name = generatedIndexName(
      manifest.metadata.name,
      declaration.fields,
      declaration.unique,
      relationOrdered,
    );
    const indexColumns = columnNames.map(quoteIdent);
    if (relationOrdered) indexColumns.push('"updated_at" DESC', '"id" DESC');
    indexes.push({
      name,
      sql:
        `CREATE ${declaration.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(name)} ` +
        `ON entries(${indexColumns.join(", ")}) ` +
        `WHERE ${quoteIdent(columnNames[0]!)} IS NOT NULL`,
    });
  }

  return { columns: [...columns.values()], indexes };
}

/**
 * Return the opaque generated-column SQL reference for a declared field.
 * Native/reserved and undeclared fields return null. An optional table alias
 * is identifier-quoted, so site-owned Procedure joins never interpolate it.
 */
export function schemaIndexedFieldSql(
  schema: SchemaManifest,
  field: string,
  tableAlias?: string,
): string | null {
  const checked = checkedIndexes(schema);
  const indexed = checked.declarations
    .flatMap((declaration) => declaration.fields)
    .find((candidate) => candidate.name === field);
  if (!indexed) return null;
  const column = quoteIdent(generatedColumnName(schema.metadata.name, indexed));
  return tableAlias === undefined ? column : `${quoteIdent(tableAlias)}.${column}`;
}

function checkedIndexes(manifest: SchemaManifest): ReturnType<typeof checkSchemaIndexes> {
  const checked = checkSchemaIndexes(manifest);
  const first = checked.problems[0];
  if (first) {
    throw new Error(`invalid Schema index declaration at ${first.pointer}: ${first.message}`);
  }
  return checked;
}

function generatedColumnName(collection: string, field: ResolvedSchemaIndexField): string {
  return `m2c_${utf8Hex(collection)}_${utf8Hex(field.name)}_${utf8Hex(field.affinity)}`;
}

function generatedIndexName(
  collection: string,
  fields: readonly ResolvedSchemaIndexField[],
  unique: boolean,
  relationOrdered: boolean,
): string {
  const encodedFields = fields
    .map((field) => `${utf8Hex(field.name)}_${utf8Hex(field.affinity)}`)
    .join("__");
  return `m2${relationOrdered ? "r" : unique ? "u" : "i"}_${utf8Hex(collection)}_${encodedFields}`;
}

function isRelationshipField(manifest: SchemaManifest, field: string): boolean {
  return manifest.spec.translates?.on === field ||
    typeof manifest.spec.schema.properties?.[field]?.[MANTLE_REF_KEYWORD] === "string";
}

function utf8Hex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function jsonPath(field: string): string {
  return `$."${field}"`;
}

function quoteText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
