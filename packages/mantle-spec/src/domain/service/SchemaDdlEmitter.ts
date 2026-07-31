import type { SchemaManifest } from "../model/ManifestGrammar.js";
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

/**
 * Build generated columns and ordered composite indexes for one Schema.
 * Both declaration kinds share the same validated fields and columns.
 */
export function buildDdl(manifest: SchemaManifest): DdlStatements {
  const checked = checkedIndexes(manifest);
  const columns = new Map<string, DdlStatements["columns"][number]>();
  const indexes: Array<DdlStatements["indexes"][number]> = [];

  for (const declaration of checked.declarations) {
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
    );
    indexes.push({
      name,
      sql:
        `CREATE ${declaration.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(name)} ` +
        `ON entries(${columnNames.map(quoteIdent).join(", ")}) ` +
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
): string {
  const encodedFields = fields
    .map((field) => `${utf8Hex(field.name)}_${utf8Hex(field.affinity)}`)
    .join("__");
  return `m2${unique ? "u" : "i"}_${utf8Hex(collection)}_${encodedFields}`;
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
