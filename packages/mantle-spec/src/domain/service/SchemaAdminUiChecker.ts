import type { SchemaManifest } from "../model/ManifestGrammar.js";
import { checkSchemaIndexes } from "./SchemaIndexChecker.js";

export interface SchemaListFilter {
  readonly field: string;
  readonly values: readonly string[];
}

export interface SchemaAdminUiProblem {
  readonly pointer: string;
  readonly value?: unknown;
  readonly expected: string;
  readonly message: string;
}

export function checkSchemaListFilter(schema: SchemaManifest): {
  readonly filter: SchemaListFilter | null;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  const list = schema.spec.uiSchema?.["list"];
  if (list === undefined) return { filter: null, problems: [] };
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    return invalid("/spec/uiSchema/list", list, "an object", "Schema.spec.uiSchema.list must be an object.");
  }
  const field = (list as Record<string, unknown>)["filterField"];
  if (field === undefined) return { filter: null, problems: [] };
  if (typeof field !== "string" || !field) {
    return invalid(
      "/spec/uiSchema/list/filterField",
      field,
      "a non-empty top-level field name",
      "Schema.spec.uiSchema.list.filterField must be a field-name string.",
    );
  }
  if ((schema.spec.lifecycle ?? "publishing") !== "operational") {
    return invalid(
      "/spec/uiSchema/list/filterField",
      field,
      "a filter on an operational Schema",
      "Schema list filter tabs are supported for lifecycle: operational in v0.1.",
    );
  }
  const property = schema.spec.schema.properties?.[field];
  const values = property?.enum;
  if (!property) {
    return invalid(
      "/spec/uiSchema/list/filterField",
      field,
      "an exact top-level key in spec.schema.properties",
      `Schema '${schema.metadata.name}' list filter references unknown field '${field}'.`,
    );
  }
  if (!values?.length || !values.every((value): value is string => typeof value === "string")) {
    return invalid(
      "/spec/uiSchema/list/filterField",
      field,
      "a field with a non-empty string enum",
      `Schema '${schema.metadata.name}' list filter field '${field}' must declare string enum values.`,
    );
  }
  const indexed = checkSchemaIndexes(schema).declarations.some(({ fields }) => fields[0]?.name === field);
  if (!indexed) {
    return invalid(
      "/spec/uiSchema/list/filterField",
      field,
      "the first field of a declared index tuple",
      `Schema '${schema.metadata.name}' list filter field '${field}' needs a left-prefix index.`,
    );
  }
  return { filter: { field, values }, problems: [] };
}

function invalid(
  pointer: string,
  value: unknown,
  expected: string,
  message: string,
): { readonly filter: null; readonly problems: readonly SchemaAdminUiProblem[] } {
  return { filter: null, problems: [{ pointer, value, expected, message }] };
}
