import type { SchemaManifest } from "../model/ManifestGrammar.js";

export interface SchemaSearchProblem {
  readonly category: "shape" | "invalid" | "field-unknown";
  readonly pointer: string;
  readonly value?: unknown;
  readonly expected: string;
  readonly candidates?: readonly string[];
  readonly message: string;
}

export function checkSchemaSearchableFields(
  manifest: SchemaManifest,
): readonly SchemaSearchProblem[] {
  const raw = (manifest.spec as unknown as Record<string, unknown>)["searchableFields"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return [{
      category: "shape",
      pointer: "/spec/searchableFields",
      value: raw,
      expected: "an array of unique top-level string field names",
      message: "Schema.spec.searchableFields must be an array of field-name strings.",
    }];
  }

  const properties = manifest.spec.schema.properties ?? {};
  const candidates = Object.keys(properties);
  const seen = new Set<string>();
  const problems: SchemaSearchProblem[] = [];
  raw.forEach((value, index) => {
    const pointer = `/spec/searchableFields/${index}`;
    if (typeof value !== "string") {
      problems.push({
        category: "shape",
        pointer,
        value,
        expected: "a field-name string",
        message: `Schema.spec.searchableFields[${index}] must be a field-name string.`,
      });
      return;
    }
    if (seen.has(value)) {
      problems.push({
        category: "invalid",
        pointer,
        value,
        expected: "each field to appear once",
        message: `Schema.spec.searchableFields repeats field '${value}'.`,
      });
      return;
    }
    seen.add(value);
    if (!Object.hasOwn(properties, value)) {
      problems.push({
        category: "field-unknown",
        pointer,
        value,
        expected: "an exact top-level key in spec.schema.properties",
        candidates,
        message: `Schema '${manifest.metadata.name}' searchableFields references unknown top-level field '${value}'.`,
      });
      return;
    }
    if (!isStringProperty(properties[value])) {
      problems.push({
        category: "invalid",
        pointer,
        value,
        expected: "a top-level string property, optionally nullable, not a date or date-time",
        message: `Schema '${manifest.metadata.name}' searchable field '${value}' is not a string property.`,
      });
    }
  });
  return problems;
}

function isStringProperty(property: unknown): boolean {
  if (!property || typeof property !== "object" || Array.isArray(property)) return false;
  const rawType = (property as Record<string, unknown>)["type"];
  // a date or a timestamp is stored as a number (ADR-0034 decision 5), so its text is not what search would match
  if (["date", "date-time"].includes(String((property as Record<string, unknown>)["format"]))) return false;
  if (rawType === "string") return true;
  return Array.isArray(rawType) &&
    rawType.length > 0 &&
    rawType.every((type) => type === "string" || type === "null") &&
    rawType.includes("string");
}
