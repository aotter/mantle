import type { JsonSchema, SchemaManifest, ViewManifest } from "../model/ManifestGrammar.js";
import { checkSchemaIndexes } from "./SchemaIndexChecker.js";

export interface SchemaListFilter {
  readonly field: string;
  readonly values: readonly string[];
}

export interface SchemaListPresentation {
  readonly primaryField: string | null;
  readonly columns: readonly string[];
}

export interface SchemaAdminUiProblem {
  readonly pointer: string;
  readonly value?: unknown;
  readonly expected: string;
  readonly message: string;
}

export interface ViewListPresentation {
  readonly columns: readonly string[];
  readonly searchFields: readonly string[];
  readonly filterFields: readonly string[];
}

const EMPTY_VIEW_LIST: ViewListPresentation = {
  columns: [],
  searchFields: [],
  filterFields: [],
};

/** Validate the deliberately small Admin list contract for staff Views. */
export function checkViewAdminUi(view: ViewManifest): {
  readonly list: ViewListPresentation;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  const uiSchema = view.spec.uiSchema;
  if (uiSchema === undefined) return { list: EMPTY_VIEW_LIST, problems: [] };
  if (view.spec.surface !== "staff") {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      "/spec/uiSchema",
      uiSchema,
      "Admin UI configuration on a surface: staff View",
      "View.spec.uiSchema is only supported for surface: staff Views.",
    )] };
  }
  if (!uiSchema || typeof uiSchema !== "object" || Array.isArray(uiSchema)) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      "/spec/uiSchema",
      uiSchema,
      "an object",
      "View.spec.uiSchema must be an object.",
    )] };
  }
  const unknownRoot = Object.keys(uiSchema).find((key) => key !== "list");
  if (unknownRoot) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      `/spec/uiSchema/${unknownRoot}`,
      uiSchema[unknownRoot],
      "list",
      `View.spec.uiSchema.${unknownRoot} is not supported.`,
    )] };
  }
  const list = uiSchema["list"];
  if (list === undefined) return { list: EMPTY_VIEW_LIST, problems: [] };
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      "/spec/uiSchema/list",
      list,
      "an object",
      "View.spec.uiSchema.list must be an object.",
    )] };
  }
  const config = list as Record<string, unknown>;
  const allowed = new Set(["columns", "searchFields", "filterFields"]);
  const unknown = Object.keys(config).find((key) => !allowed.has(key));
  if (unknown) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      `/spec/uiSchema/list/${unknown}`,
      config[unknown],
      "columns, searchFields, or filterFields",
      `View.spec.uiSchema.list.${unknown} is not supported.`,
    )] };
  }
  const normalized: Record<keyof ViewListPresentation, readonly string[]> = {
    columns: [],
    searchFields: [],
    filterFields: [],
  };
  for (const key of Object.keys(normalized) as Array<keyof ViewListPresentation>) {
    const raw = config[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || !raw.every((field) =>
      typeof field === "string" && field.length > 0 && !/["\\\0]/.test(field)
    )) {
      return { list: EMPTY_VIEW_LIST, problems: [problem(
        `/spec/uiSchema/list/${key}`,
        raw,
        "an array of non-empty View output field names",
        `View.spec.uiSchema.list.${key} must be an array of field-name strings.`,
      )] };
    }
    if (new Set(raw).size !== raw.length) {
      return { list: EMPTY_VIEW_LIST, problems: [problem(
        `/spec/uiSchema/list/${key}`,
        raw,
        "field names without duplicates",
        `View.spec.uiSchema.list.${key} must not repeat a field.`,
      )] };
    }
    normalized[key] = raw;
  }
  return { list: normalized, problems: [] };
}

const EMPTY_LIST: SchemaListPresentation = { primaryField: null, columns: [] };
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

export function schemaSortableFields(schema: SchemaManifest): readonly string[] {
  const required = new Set(schema.spec.schema.required ?? []);
  return [...new Set(
    checkSchemaIndexes(schema).declarations
      .map(({ fields }) => fields[0]?.name)
      .filter((field): field is string => field !== undefined && required.has(field)),
  )];
}

export function checkSchemaAdminUi(schema: SchemaManifest): {
  readonly filter: SchemaListFilter | null;
  readonly list: SchemaListPresentation;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  const formProblem = checkFormUiSchema(schema.spec.schema, schema.spec.uiSchema, "Schema")[0];
  if (formProblem) return invalid(formProblem);

  const list = schema.spec.uiSchema?.["list"];
  if (list === undefined) return { filter: null, list: EMPTY_LIST, problems: [] };
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    return invalid(problem(
      "/spec/uiSchema/list",
      list,
      "an object",
      "Schema.spec.uiSchema.list must be an object.",
    ));
  }

  const config = list as Record<string, unknown>;
  const filterResult = checkListFilter(schema, config);
  if (filterResult.problem) return invalid(filterResult.problem);

  const primaryField = config["primaryField"];
  const columns = config["columns"];
  const declaresPresentation = primaryField !== undefined || columns !== undefined;
  if (declaresPresentation && (schema.spec.lifecycle ?? "publishing") !== "operational") {
    return invalid(problem(
      "/spec/uiSchema/list",
      list,
      "list presentation fields on an operational Schema",
      "Schema list primaryField/columns are supported for lifecycle: operational in v0.1.",
    ));
  }

  if (primaryField !== undefined && (typeof primaryField !== "string" || !primaryField)) {
    return invalid(problem(
      "/spec/uiSchema/list/primaryField",
      primaryField,
      "a non-empty top-level scalar field name",
      "Schema.spec.uiSchema.list.primaryField must be a field-name string.",
    ));
  }
  if (columns !== undefined && (!Array.isArray(columns) || !columns.every((field) => typeof field === "string" && field.length > 0))) {
    return invalid(problem(
      "/spec/uiSchema/list/columns",
      columns,
      "an array of non-empty top-level scalar field names",
      "Schema.spec.uiSchema.list.columns must be an array of field-name strings.",
    ));
  }

  const normalizedPrimary = typeof primaryField === "string" ? primaryField : null;
  const normalizedColumns = Array.isArray(columns) ? columns as string[] : [];
  const fields = [...(normalizedPrimary ? [normalizedPrimary] : []), ...normalizedColumns];
  if (new Set(fields).size !== fields.length) {
    return invalid(problem(
      "/spec/uiSchema/list/columns",
      columns,
      "field names without duplicates or the primaryField",
      "Schema list primaryField/columns must not repeat a field.",
    ));
  }
  for (const field of fields) {
    const property = schema.spec.schema.properties?.[field];
    if (!property) {
      return invalid(problem(
        `/spec/uiSchema/list/${field === normalizedPrimary ? "primaryField" : "columns"}`,
        field,
        "an exact top-level key in spec.schema.properties",
        `Schema '${schema.metadata.name}' list presentation references unknown field '${field}'.`,
      ));
    }
    if (!isScalar(property)) {
      return invalid(problem(
        `/spec/uiSchema/list/${field === normalizedPrimary ? "primaryField" : "columns"}`,
        field,
        "a top-level scalar Schema property",
        `Schema '${schema.metadata.name}' list field '${field}' must be scalar.`,
      ));
    }
  }

  return {
    filter: filterResult.filter,
    list: { primaryField: normalizedPrimary, columns: normalizedColumns },
    problems: [],
  };
}

export function checkFormUiSchema(
  schema: JsonSchema,
  uiSchema: unknown,
  owner: "Schema" | "Procedure",
): readonly SchemaAdminUiProblem[] {
  if (uiSchema === undefined) return [];
  if (!uiSchema || typeof uiSchema !== "object" || Array.isArray(uiSchema)) {
    return [problem(
      "/spec/uiSchema",
      uiSchema,
      "an object",
      `${owner}.spec.uiSchema must be an object.`,
    )];
  }
  const config = uiSchema as Record<string, unknown>;
  const collectionAction = config["collectionAction"];
  if (collectionAction !== undefined && owner !== "Procedure") {
    return [problem(
      "/spec/uiSchema/collectionAction",
      collectionAction,
      "a Procedure-only Admin collection name",
      "Schema.spec.uiSchema.collectionAction is not supported.",
    )];
  }
  if (collectionAction !== undefined && (typeof collectionAction !== "string" || !collectionAction)) {
    return [problem(
      "/spec/uiSchema/collectionAction",
      collectionAction,
      "a non-empty Schema name",
      "Procedure.spec.uiSchema.collectionAction must be a Schema-name string.",
    )];
  }
  const fields = config["fields"];
  if (fields === undefined) return [];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return [problem(
      "/spec/uiSchema/fields",
      fields,
      "an object keyed by top-level input field",
      `${owner}.spec.uiSchema.fields must be an object.`,
    )];
  }
  for (const [field, rawConfig] of Object.entries(fields)) {
    const property = schema.properties?.[field];
    if (!property) {
      return [problem(
        `/spec/uiSchema/fields/${field}`,
        field,
        "an exact top-level key in the JSON Schema properties",
        `${owner}.spec.uiSchema.fields references unknown field '${field}'.`,
      )];
    }
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      return [problem(
        `/spec/uiSchema/fields/${field}`,
        rawConfig,
        "an object with widget: textarea",
        `${owner}.spec.uiSchema.fields.${field} must be an object.`,
      )];
    }
    const config = rawConfig as Record<string, unknown>;
    if (config["widget"] !== "textarea") {
      return [problem(
        `/spec/uiSchema/fields/${field}/widget`,
        config["widget"],
        '"textarea"',
        `${owner}.spec.uiSchema.fields.${field}.widget must be 'textarea'.`,
      )];
    }
    if (!isString(property)) {
      return [problem(
        `/spec/uiSchema/fields/${field}/widget`,
        field,
        "a top-level string property",
        `${owner}.spec.uiSchema.fields.${field}.widget can only target a string field.`,
      )];
    }
  }
  return [];
}

function checkListFilter(
  schema: SchemaManifest,
  list: Record<string, unknown>,
): { readonly filter: SchemaListFilter | null; readonly problem?: SchemaAdminUiProblem } {
  const field = list["filterField"];
  if (field === undefined) return { filter: null };
  if (typeof field !== "string" || !field) {
    return { problem: problem(
      "/spec/uiSchema/list/filterField",
      field,
      "a non-empty top-level field name",
      "Schema.spec.uiSchema.list.filterField must be a field-name string.",
    ), filter: null };
  }
  if ((schema.spec.lifecycle ?? "publishing") !== "operational") {
    return { problem: problem(
      "/spec/uiSchema/list/filterField",
      field,
      "a filter on an operational Schema",
      "Schema list filter tabs are supported for lifecycle: operational in v0.1.",
    ), filter: null };
  }
  const property = schema.spec.schema.properties?.[field];
  const values = property?.enum;
  if (!property) {
    return { problem: problem(
      "/spec/uiSchema/list/filterField",
      field,
      "an exact top-level key in spec.schema.properties",
      `Schema '${schema.metadata.name}' list filter references unknown field '${field}'.`,
    ), filter: null };
  }
  if (!values?.length || !values.every((value): value is string => typeof value === "string")) {
    return { problem: problem(
      "/spec/uiSchema/list/filterField",
      field,
      "a field with a non-empty string enum",
      `Schema '${schema.metadata.name}' list filter field '${field}' must declare string enum values.`,
    ), filter: null };
  }
  const indexed = checkSchemaIndexes(schema).declarations.some(({ fields }) => fields[0]?.name === field);
  if (!indexed) {
    return { problem: problem(
      "/spec/uiSchema/list/filterField",
      field,
      "the first field of a declared index tuple",
      `Schema '${schema.metadata.name}' list filter field '${field}' needs a left-prefix index.`,
    ), filter: null };
  }
  return { filter: { field, values } };
}

function isScalar(schema: JsonSchema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return types.some((type) => SCALAR_TYPES.has(type)) &&
    types.every((type) => type === "null" || SCALAR_TYPES.has(type));
}

function isString(schema: JsonSchema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return types.includes("string") && types.every((type) => type === "string" || type === "null");
}

function problem(
  pointer: string,
  value: unknown,
  expected: string,
  message: string,
): SchemaAdminUiProblem {
  return { pointer, value, expected, message };
}

function invalid(problem: SchemaAdminUiProblem): {
  readonly filter: null;
  readonly list: SchemaListPresentation;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  return { filter: null, list: EMPTY_LIST, problems: [problem] };
}
