import {
  RESERVED_ENTRY_COLUMNS,
  type SchemaManifest,
} from "../model/ManifestGrammar.js";
import type { DiagnosticCode } from "../../kernel/diagnostic.js";

export type SchemaIndexAffinity = "TEXT" | "INTEGER" | "REAL";
export type SchemaIndexSource = "uniqueIndexes" | "indexes";

export interface ResolvedSchemaIndexField {
  readonly name: string;
  readonly affinity: SchemaIndexAffinity;
}

export interface ResolvedSchemaIndexDeclaration {
  readonly unique: boolean;
  readonly fields: readonly ResolvedSchemaIndexField[];
}

export interface SchemaIndexProblem {
  readonly category: "shape" | "invalid" | "field-unknown";
  readonly source?: SchemaIndexSource;
  readonly pointer: string;
  readonly value?: unknown;
  readonly expected: string;
  readonly candidates?: readonly string[];
  readonly message: string;
}

export interface SchemaIndexCheckResult {
  readonly declarations: readonly ResolvedSchemaIndexDeclaration[];
  readonly problems: readonly SchemaIndexProblem[];
}

const SAFE_INDEX_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const RESERVED_INDEX_FIELDS: ReadonlySet<string> = new Set(RESERVED_ENTRY_COLUMNS);
const SOURCES = ["uniqueIndexes", "indexes"] as const;

/**
 * Validate and resolve both Schema index declaration kinds in one pass.
 * This is deliberately internal to mantle-spec: parser, static validation,
 * DDL, and query helpers share the rules without adding a public catalog.
 */
export function checkSchemaIndexes(manifest: SchemaManifest): SchemaIndexCheckResult {
  const spec = manifest.spec as unknown as Record<string, unknown>;
  const schema = isRecord(spec["schema"]) ? spec["schema"] : {};
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const candidates = Object.keys(properties);
  const declarations: ResolvedSchemaIndexDeclaration[] = [];
  const problems: SchemaIndexProblem[] = [];
  const seen = new Map<string, SchemaIndexSource>();

  const hasDeclarations = SOURCES.some((source) => {
    const raw = spec[source];
    return Array.isArray(raw) && raw.length > 0;
  });
  if (hasDeclarations && !SAFE_INDEX_NAME.test(manifest.metadata.name)) {
    problems.push({
      category: "invalid",
      pointer: "/metadata/name",
      value: manifest.metadata.name,
      expected: `indexed Schema name matching ${SAFE_INDEX_NAME}`,
      message: `Schema '${manifest.metadata.name}' uses indexes but its name is not a safe index identifier.`,
    });
  }

  for (const source of SOURCES) {
    const raw = spec[source];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      problems.push({
        category: "shape",
        source,
        pointer: `/spec/${source}`,
        value: raw,
        expected: "an array of non-empty string arrays",
        message: `Schema.spec.${source} must be an array of non-empty string arrays.`,
      });
      continue;
    }

    for (let compositeIndex = 0; compositeIndex < raw.length; compositeIndex += 1) {
      const rawComposite = raw[compositeIndex];
      const compositePointer = `/spec/${source}/${compositeIndex}`;
      if (!Array.isArray(rawComposite)) {
        problems.push({
          category: "shape",
          source,
          pointer: compositePointer,
          value: rawComposite,
          expected: "a non-empty array of field-name strings",
          message: `Schema.spec.${source}[${compositeIndex}] must be a non-empty array of field-name strings.`,
        });
        continue;
      }
      if (rawComposite.length === 0) {
        problems.push({
          category: "invalid",
          source,
          pointer: compositePointer,
          value: rawComposite,
          expected: "at least one indexed field",
          message: `Schema.spec.${source}[${compositeIndex}] must not be empty.`,
        });
        continue;
      }

      const fields: ResolvedSchemaIndexField[] = [];
      const fieldsSeen = new Set<string>();
      let valid = true;
      for (let fieldIndex = 0; fieldIndex < rawComposite.length; fieldIndex += 1) {
        const rawField = rawComposite[fieldIndex];
        const fieldPointer = `${compositePointer}/${fieldIndex}`;
        if (typeof rawField !== "string") {
          valid = false;
          problems.push({
            category: "shape",
            source,
            pointer: fieldPointer,
            value: rawField,
            expected: "a field-name string",
            message: `Schema.spec.${source}[${compositeIndex}][${fieldIndex}] must be a field-name string.`,
          });
          continue;
        }
        if (fieldsSeen.has(rawField)) {
          valid = false;
          problems.push({
            category: "invalid",
            source,
            pointer: fieldPointer,
            value: rawField,
            expected: "each field to appear once per composite index",
            message: `Schema.spec.${source}[${compositeIndex}] repeats field '${rawField}'.`,
          });
          continue;
        }
        fieldsSeen.add(rawField);
        if (!SAFE_INDEX_NAME.test(rawField)) {
          valid = false;
          problems.push({
            category: "invalid",
            source,
            pointer: fieldPointer,
            value: rawField,
            expected: `field name matching ${SAFE_INDEX_NAME}`,
            message: `Schema.spec.${source} field '${rawField}' is not a safe index identifier.`,
          });
          continue;
        }
        if (RESERVED_INDEX_FIELDS.has(rawField)) {
          valid = false;
          problems.push({
            category: "invalid",
            source,
            pointer: fieldPointer,
            value: rawField,
            expected: "a non-reserved Schema data field",
            message: `Schema.spec.${source} cannot index reserved native field '${rawField}'.`,
          });
          continue;
        }
        if (!Object.hasOwn(properties, rawField)) {
          valid = false;
          problems.push({
            category: "field-unknown",
            source,
            pointer: fieldPointer,
            value: rawField,
            expected: "an exact top-level key in spec.schema.properties",
            candidates,
            message: `Schema '${manifest.metadata.name}' ${source} references unknown top-level field '${rawField}'.`,
          });
          continue;
        }
        const affinity = scalarAffinity(properties[rawField]);
        if (affinity === null) {
          valid = false;
          problems.push({
            category: "invalid",
            source,
            pointer: fieldPointer,
            value: rawField,
            expected: "a property with exactly one string, integer, number, or boolean type, optionally nullable",
            message: `Schema '${manifest.metadata.name}' ${source} field '${rawField}' is not an indexable scalar property.`,
          });
          continue;
        }
        fields.push({ name: rawField, affinity });
      }

      if (!valid) continue;
      const key = JSON.stringify(fields.map((field) => field.name));
      const previous = seen.get(key);
      if (previous !== undefined) {
        const crossKind = previous !== source;
        problems.push({
          category: "invalid",
          source,
          pointer: compositePointer,
          value: fields.map((field) => field.name),
          expected: crossKind
            ? "a tuple not already supplied by uniqueIndexes"
            : `a unique ordered tuple within ${source}`,
          message: crossKind
            ? `Schema.spec.indexes duplicates uniqueIndexes tuple ${key}; the unique index already supplies that lookup path.`
            : `Schema.spec.${source} repeats ordered tuple ${key}.`,
        });
        continue;
      }
      seen.set(key, source);
      declarations.push({
        unique: source === "uniqueIndexes",
        fields,
      });
    }
  }

  return { declarations, problems };
}

export function schemaIndexDiagnosticCode(
  problem: SchemaIndexProblem,
  parserShape: boolean = false,
): DiagnosticCode {
  if (problem.category === "shape") {
    return parserShape ? "INVALID_MANIFEST_ENVELOPE" : "SCHEMA_INDEX_INVALID";
  }
  if (problem.category === "field-unknown") {
    return problem.source === "uniqueIndexes"
      ? "UNIQUE_INDEX_FIELD_UNKNOWN"
      : "SCHEMA_INDEX_FIELD_UNKNOWN";
  }
  return "SCHEMA_INDEX_INVALID";
}

function scalarAffinity(rawProperty: unknown): SchemaIndexAffinity | null {
  if (!isRecord(rawProperty)) return null;
  if (
    rawProperty["nullable"] !== undefined &&
    typeof rawProperty["nullable"] !== "boolean"
  ) {
    return null;
  }
  const rawType = rawProperty["type"];
  const types = typeof rawType === "string"
    ? [rawType]
    : Array.isArray(rawType) && rawType.every((value) => typeof value === "string")
      ? rawType
      : null;
  if (types === null || types.length === 0 || new Set(types).size !== types.length) {
    return null;
  }
  const nonNull = types.filter((type) => type !== "null");
  if (nonNull.length !== 1 || types.length > 2) return null;
  switch (nonNull[0]) {
    case "string":
      return "TEXT";
    case "integer":
    case "boolean":
      return "INTEGER";
    case "number":
      return "REAL";
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
