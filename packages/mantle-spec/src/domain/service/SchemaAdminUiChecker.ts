import type { JsonSchema, SchemaManifest, ViewManifest } from "../model/ManifestGrammar.js";
import { MANTLE_REF_KEYWORD, RESERVED_ENTRY_COLUMNS } from "../model/ManifestGrammar.js";
import { checkSchemaIndexes } from "./SchemaIndexChecker.js";

export interface SchemaListFilter {
  readonly field: string;
  readonly values: readonly string[];
}

export interface SchemaListPresentation {
  readonly primaryField: string | null;
  readonly columns: readonly string[];
}

/** Normalized Admin nav descriptor. Absent/`null` means fold-only. */
export interface SchemaNavPresentation {
  readonly standalone: true;
  readonly parentField: string;
  readonly parentCollection: string;
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
const SCHEMA_UI_ROOTS = new Set(["fields", "list", "nav"]);
const SCHEMA_LIST_KEYS = new Set(["filterField", "primaryField", "columns"]);
const SCHEMA_NAV_KEYS = new Set(["standalone", "parentField"]);
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
  readonly nav: SchemaNavPresentation | null;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  const formProblem = checkFormUiSchema(schema.spec.schema, schema.spec.uiSchema, "Schema")[0];
  if (formProblem) return invalid(formProblem);

  const uiSchema = schema.spec.uiSchema;
  if (uiSchema === undefined) return { filter: null, list: EMPTY_LIST, nav: null, problems: [] };
  const roots = uiSchema as Record<string, unknown>;
  const unknownRoot = Object.keys(roots).find((key) => !SCHEMA_UI_ROOTS.has(key));
  if (unknownRoot) {
    return invalid(problem(
      `/spec/uiSchema/${unknownRoot}`,
      roots[unknownRoot],
      "fields, list, or nav",
      `Schema.spec.uiSchema.${unknownRoot} is not supported.`,
    ));
  }

  const list = roots["list"];
  if (list !== undefined && (!list || typeof list !== "object" || Array.isArray(list))) {
    return invalid(problem(
      "/spec/uiSchema/list",
      list,
      "an object",
      "Schema.spec.uiSchema.list must be an object.",
    ));
  }

  const config = (list ?? {}) as Record<string, unknown>;
  if (list !== undefined) {
    const unknownList = Object.keys(config).find((key) => !SCHEMA_LIST_KEYS.has(key));
    if (unknownList) {
      return invalid(problem(
        `/spec/uiSchema/list/${unknownList}`,
        config[unknownList],
        "filterField, primaryField, or columns",
        `Schema.spec.uiSchema.list.${unknownList} is not supported.`,
      ));
    }
  }
  const filterResult = list === undefined
    ? { filter: null as SchemaListFilter | null }
    : checkListFilter(schema, config);
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
      "an array of non-empty top-level field names",
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
    // Native entry columns carry no `properties` entry but are listable, so a
    // column may name one. `primaryField` is the entry title and stays a
    // declared data property: a native column would render no useful title.
    if (field !== normalizedPrimary && NATIVE_LIST_FIELDS.has(field)) continue;
    const property = schema.spec.schema.properties?.[field];
    if (!property) {
      return invalid(problem(
        `/spec/uiSchema/list/${field === normalizedPrimary ? "primaryField" : "columns"}`,
        field,
        "a top-level key in spec.schema.properties or a native entry column",
        `Schema '${schema.metadata.name}' list presentation references unknown field '${field}'.`,
      ));
    }
    if (field === normalizedPrimary && !isScalar(property)) {
      return invalid(problem(
        "/spec/uiSchema/list/primaryField",
        field,
        "a top-level scalar Schema property",
        `Schema '${schema.metadata.name}' list primaryField '${field}' must be scalar.`,
      ));
    }
  }

  const navResult = checkNav(schema, roots["nav"]);
  if (navResult.problem) return invalid(navResult.problem);

  return {
    filter: filterResult.filter,
    list: { primaryField: normalizedPrimary, columns: normalizedColumns },
    nav: navResult.nav,
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
  if (owner === "Procedure") {
    const unknownRoot = Object.keys(config).find((key) => key !== "collectionAction" && key !== "fields");
    if (unknownRoot) {
      return [problem(
        `/spec/uiSchema/${unknownRoot}`,
        config[unknownRoot],
        "collectionAction or fields",
        `Procedure.spec.uiSchema.${unknownRoot} is not supported.`,
      )];
    }
  }
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

function checkNav(
  schema: SchemaManifest,
  nav: unknown,
): { readonly nav: SchemaNavPresentation | null; readonly problem?: SchemaAdminUiProblem } {
  if (nav === undefined) return { nav: null };
  if (!nav || typeof nav !== "object" || Array.isArray(nav)) {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav",
        nav,
        "an object",
        "Schema.spec.uiSchema.nav must be an object.",
      ),
    };
  }
  const config = nav as Record<string, unknown>;
  const unknown = Object.keys(config).find((key) => !SCHEMA_NAV_KEYS.has(key));
  if (unknown) {
    return {
      nav: null,
      problem: problem(
        `/spec/uiSchema/nav/${unknown}`,
        config[unknown],
        "standalone or parentField",
        `Schema.spec.uiSchema.nav.${unknown} is not supported.`,
      ),
    };
  }

  const standalone = config["standalone"];
  if (standalone !== undefined && typeof standalone !== "boolean") {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/standalone",
        standalone,
        "a boolean",
        "Schema.spec.uiSchema.nav.standalone must be a boolean.",
      ),
    };
  }

  const parentField = config["parentField"];
  if (parentField !== undefined && (typeof parentField !== "string" || !parentField)) {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/parentField",
        parentField,
        "a non-empty required x-mantle-ref field name",
        "Schema.spec.uiSchema.nav.parentField must be a field-name string.",
      ),
    };
  }

  if (parentField !== undefined && standalone !== true) {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/parentField",
        parentField,
        "parentField only with standalone: true",
        "Schema.spec.uiSchema.nav.parentField requires nav.standalone: true.",
      ),
    };
  }

  if (standalone !== true) return { nav: null };

  if (schema.spec.translates) {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/standalone",
        true,
        "standalone on a Schema that folds under a required-ref parent",
        `Schema '${schema.metadata.name}' cannot declare nav.standalone because it is a translates child.`,
      ),
    };
  }

  const eligible = requiredMantleRefFields(schema);
  if (eligible.length === 0) {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/standalone",
        true,
        "standalone on a Schema with a required x-mantle-ref parent",
        `Schema '${schema.metadata.name}' cannot declare nav.standalone: it has no required x-mantle-ref parent to fold under.`,
      ),
    };
  }

  if (eligible.length === 1) {
    const only = eligible[0]!;
    if (typeof parentField === "string" && parentField !== only.field) {
      return {
        nav: null,
        problem: problem(
          "/spec/uiSchema/nav/parentField",
          parentField,
          `the Schema's only required x-mantle-ref field '${only.field}'`,
          `Schema '${schema.metadata.name}' nav.parentField must be '${only.field}'.`,
        ),
      };
    }
    return {
      nav: { standalone: true, parentField: only.field, parentCollection: only.collection },
    };
  }

  if (typeof parentField !== "string") {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/parentField",
        parentField,
        `one of ${eligible.map((item) => item.field).join(", ")}`,
        `Schema '${schema.metadata.name}' declares more than one required x-mantle-ref; nav.parentField is required.`,
      ),
    };
  }
  const matched = eligible.find((item) => item.field === parentField);
  if (!matched) {
    return {
      nav: null,
      problem: problem(
        "/spec/uiSchema/nav/parentField",
        parentField,
        `one of ${eligible.map((item) => item.field).join(", ")}`,
        `Schema '${schema.metadata.name}' nav.parentField must name a required x-mantle-ref field.`,
      ),
    };
  }
  return {
    nav: { standalone: true, parentField: matched.field, parentCollection: matched.collection },
  };
}

/** Required top-level properties that carry `x-mantle-ref`. Order follows
 *  `properties` declaration — callers must not treat that order as a
 *  standalone-filter default when more than one field is eligible. */
export function requiredMantleRefFields(
  schema: SchemaManifest,
): readonly { readonly field: string; readonly collection: string }[] {
  const required = new Set(schema.spec.schema.required ?? []);
  const properties = schema.spec.schema.properties ?? {};
  const fields: Array<{ field: string; collection: string }> = [];
  for (const [field, property] of Object.entries(properties)) {
    if (!required.has(field)) continue;
    const collection = property[MANTLE_REF_KEYWORD];
    if (typeof collection === "string" && collection.length > 0) {
      fields.push({ field, collection });
    }
  }
  return fields;
}

export function isRequiredMantleRefField(schema: SchemaManifest, field: string): boolean {
  return requiredMantleRefFields(schema).some((item) => item.field === field);
}

/** Graph-time: standalone parent collection must exist and not be a translates child. */
export function checkSchemaNavTargets(
  schema: SchemaManifest,
  schemasByName: ReadonlyMap<string, SchemaManifest>,
): SchemaAdminUiProblem | null {
  const { nav, problems } = checkSchemaAdminUi(schema);
  if (problems.length > 0 || !nav) return null;
  const parent = schemasByName.get(nav.parentCollection);
  if (!parent || parent.spec.translates) {
    const declaredParentField = schema.spec.uiSchema
      && typeof schema.spec.uiSchema === "object"
      && !Array.isArray(schema.spec.uiSchema)
      && schema.spec.uiSchema["nav"]
      && typeof schema.spec.uiSchema["nav"] === "object"
      && !Array.isArray(schema.spec.uiSchema["nav"])
      && "parentField" in (schema.spec.uiSchema["nav"] as Record<string, unknown>);
    return problem(
      declaredParentField ? "/spec/uiSchema/nav/parentField" : "/spec/uiSchema/nav/standalone",
      nav.parentCollection,
      "the metadata.name of an existing non-translates Schema",
      `Schema '${schema.metadata.name}' nav parent collection '${nav.parentCollection}' is not an eligible fold parent.`,
    );
  }
  return null;
}

const NATIVE_LIST_FIELDS: ReadonlySet<string> = new Set(RESERVED_ENTRY_COLUMNS);

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
  readonly nav: null;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  return { filter: null, list: EMPTY_LIST, nav: null, problems: [problem] };
}
