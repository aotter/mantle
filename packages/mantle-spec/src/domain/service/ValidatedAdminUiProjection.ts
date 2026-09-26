import { resolveMantleRef, type SchemaManifest, type ViewManifest } from "../model/ManifestGrammar.js";
import type { SchemaListFilter, SchemaListPresentation, SchemaNavPresentation, ViewListPresentation } from "./SchemaAdminUiChecker.js";

/** Read descriptors from an already parsed and linked manifest; no authoring checks at request time. */
export function projectSchemaAdminUi(schema: SchemaManifest): {
  readonly filter: SchemaListFilter | null;
  readonly list: SchemaListPresentation;
  readonly nav: SchemaNavPresentation | null;
  readonly sortableFields: readonly string[];
} {
  const list = (schema.spec.uiSchema?.["list"] ?? {}) as Record<string, unknown>;
  const field = list["filterField"] as string | undefined;
  const nav = schema.spec.uiSchema?.["nav"] as Record<string, unknown> | undefined;
  const required = new Set(schema.spec.schema.required ?? []);
  const parentField = nav?.["standalone"] === true
    ? (nav["parentField"] as string | undefined) ?? Object.entries(schema.spec.schema.properties ?? {})
      .find(([name, property]) => required.has(name) && resolveMantleRef(property))?.[0]
    : undefined;
  const parent = parentField && resolveMantleRef(schema.spec.schema.properties?.[parentField]);
  return {
    filter: field ? { field, values: schema.spec.schema.properties?.[field]?.enum as readonly string[] } : null,
    list: { primaryField: (list["primaryField"] as string | undefined) ?? null, columns: (list["columns"] as readonly string[] | undefined) ?? [] },
    nav: nav?.["standalone"] === true && parentField && parent
      ? { standalone: true, parentField, parentCollection: parent.schema } : null,
    sortableFields: [...new Set([...(schema.spec.uniqueIndexes ?? []), ...(schema.spec.indexes ?? [])]
      .map((index) => index[0]).filter((name): name is string => name !== undefined && required.has(name)))],
  };
}

export function projectViewAdminUi(view: ViewManifest): ViewListPresentation {
  const list = (view.spec.uiSchema?.["list"] ?? {}) as Record<string, readonly string[]>;
  return { columns: list["columns"] ?? [], searchFields: list["searchFields"] ?? [], filterFields: list["filterFields"] ?? [] };
}
