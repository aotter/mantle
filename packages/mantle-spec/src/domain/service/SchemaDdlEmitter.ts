import type { SchemaManifest } from "../model/ManifestGrammar.js";

/**
 * DDL fragments derived from a Schema manifest's `uniqueIndexes`. Pure
 * strings — no env / driver coupling. The runtime adapter feeds these
 * to the SQL engine.
 *
 * Stays in `mantle-spec` because it's manifest-shape → SQL-string
 * with zero runtime concerns; a build-time validator + the runtime's
 * migration emitter want the same string-builder. One source, two
 * consumers.
 */
export interface DdlStatements {
  /** ALTER TABLE statements adding generated virtual columns. */
  readonly addColumns: readonly string[];
  /** CREATE UNIQUE INDEX statements over the generated columns. */
  readonly createIndexes: readonly string[];
  /** Index names (used by `dropIndexes`). */
  readonly indexNames: readonly string[];
  /** Generated column names (used by `dropColumns`). */
  readonly columnNames: readonly string[];
}

const SAFE_NAME = /^[a-z][a-z0-9_.-]*$/i;

function safeIdent(name: string, kind: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`unsafe ${kind} identifier: ${name}`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${name}"`;
}

function colName(collection: string, fieldPath: string): string {
  const flat = fieldPath.replace(/\./g, "_");
  return `${safeIdent(collection, "collection")}__${safeIdent(flat, "field")}`;
}

function jsonPath(fieldPath: string): string {
  // Each segment may contain dots in the field path (e.g. `meta.slug`); JSON
  // path syntax becomes `$.meta.slug`. We don't support array indexing here.
  return `$.${fieldPath}`;
}

/**
 * Build the DDL needed to enforce a `SchemaManifest`'s `uniqueIndexes`
 * on the shared `entries` table. Generates one virtual column per
 * indexed field and one unique index per declared composite key. The
 * virtual columns are only populated when `collection = ?`, so
 * different collections coexist on the same `entries` table without
 * collisions.
 */
export function buildDdl(manifest: SchemaManifest): DdlStatements {
  const collection = safeIdent(manifest.metadata.name, "collection");
  const indexes = manifest.spec.uniqueIndexes ?? [];
  const addColumns: string[] = [];
  const createIndexes: string[] = [];
  const indexNames: string[] = [];
  const columnNames: string[] = [];
  const seen = new Set<string>();

  for (const fields of indexes) {
    if (fields.length === 0) continue;
    const cols = fields.map((f) => {
      const cn = colName(collection, f);
      if (!seen.has(cn)) {
        seen.add(cn);
        addColumns.push(
          `ALTER TABLE entries ADD COLUMN ${quoteIdent(cn)} TEXT GENERATED ALWAYS AS (` +
            `CASE WHEN collection = '${collection}' THEN json_extract(data, '${jsonPath(f)}') END` +
            `) VIRTUAL`,
        );
        columnNames.push(cn);
      }
      return cn;
    });
    const ixName = `uq_${collection}__${fields.map((f) => f.replace(/\./g, "_")).join("__")}`;
    // Partial index must require EVERY column be non-NULL; guarding
    // only cols[0] meant rows with mixed-NULL composites silently
    // collided as duplicates of (col0, NULL) — uniqueness weaker than
    // declared.
    const notNullClause = cols.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(" AND ");
    createIndexes.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(ixName)} ` +
        `ON entries(${cols.map(quoteIdent).join(", ")})` +
        ` WHERE ${notNullClause}`,
    );
    indexNames.push(ixName);
  }

  return { addColumns, createIndexes, indexNames, columnNames };
}
