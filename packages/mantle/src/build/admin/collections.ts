/** Pure collection metadata, shared by Admin and the deployment compiler. */
import { MCP_HINT_KEYWORD, NATIVE_NOT_NULL, requiredMantleRefFields, isMediaMcpHint, enumOptions, notNullColumns, resolveMantleRef, type JsonSchema, type PlanSchema } from "../spec/domain/index.js";

type Props = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export const propsOf = (s: JsonSchema) => (s.properties ?? {}) as Props;

/** @internal Columns an Admin list can order by through an index, skipping the scope prefix; the server's `adminOrder` and the descriptor's `sortableFields` both read this. */
export function adminIndexColumns(s: PlanSchema): string[] {
  const notNull = notNullColumns(s), required = new Set(s.schema.required ?? []);
  return [...(s.indexes ?? []), ...(s.unique ?? [])].map((i) => (i[0] === s.scope ? i[1] : i[0]))
    .filter((f): f is string => !!f && f !== s.scope && (required.has(s.names[f] ?? f) || NATIVE_NOT_NULL.has(f) || notNull.has(f)));
}

/** @internal What the SPA lists and edits for one Schema; a translation's parent is the entry sharing its `on`. */
export function collectionOf(s: PlanSchema, schemas: readonly PlanSchema[]) {
  const names = new Set(schemas.filter((x) => !x.translates).map((x) => x.name));
  const props = propsOf(s.schema);
  const required = new Set(s.schema.required ?? []);
  const ui = (s.uiSchema ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const list = ui["list"] ?? {};
  const nav = ui["nav"];
  const filterField = list["filterField"] as string | undefined;
  // a required reference is composition: the child sits under its parent, the declared nav.parentField first, then an `id` reference, else one by a unique field
  const refs = Object.keys(props).filter((f) => required.has(f) && names.has(resolveMantleRef(props[f])?.schema ?? ""));
  const byId = standaloneParentField(s, schemas);
  const declared = nav?.["parentField"] as string | undefined;
  const parentField = declared ?? byId ?? refs[0];
  // a standalone list's parent picker scopes by the parent's entry id, so only an `id` reference composes there (the checker agrees)
  const navField = nav?.["standalone"] === true ? declared ?? byId : undefined;
  const navParent = navField ? resolveMantleRef(props[navField]) : null;
  const children = schemas.filter((c) => c.translates?.parent === s.name);
  return {
    name: s.name, title: s.title ?? s.name, description: s.description ?? null,
    lifecycle: s.publishing ? "publishing" : "operational",
    parent: s.translates ? { collection: s.translates.parent, parentField: s.translates.on, childField: s.translates.on }
      : parentField ? { collection: resolveMantleRef(props[parentField])!.schema, parentField: resolveMantleRef(props[parentField])!.field, childField: parentField } : null,
    hasTranslations: children.length > 0, localized: s.localized === true || !!s.translates, translates: s.translates ?? null,
    schema: s.schema, uiSchema: s.uiSchema ?? null,
    mediaFields: [s, ...children].flatMap((x) => Object.entries(propsOf(x.schema)).flatMap(([name, p]) => (isMediaMcpHint(p[MCP_HINT_KEYWORD]) ? [{ name, hint: p[MCP_HINT_KEYWORD] }] : []))),
    // the plan lower-cases index columns; `names` maps them back to the declared spelling
    sortableFields: [...new Set(adminIndexColumns(s).map((f) => s.names[f] ?? f))],
    filter: filterField ? { field: filterField, values: enumOptions(props[filterField])?.map((o) => o.value) ?? [] } : null,
    list: { primaryField: (list["primaryField"] as string | undefined) ?? null, columns: (list["columns"] as string[] | undefined) ?? [] },
    nav: navField && navParent ? { standalone: true, parentField: navField, parentCollection: navParent.schema } : null,
  };
}

/** @internal The default parent field of a standalone list: the first required `id` reference to a non-translation Schema, as the checker's `nav.standalone` rule requires; undefined when standalone is refused. */
export function standaloneParentField(s: PlanSchema, schemas: readonly PlanSchema[]): string | undefined {
  if (s.translates) return undefined;
  const names = new Set(schemas.filter((x) => !x.translates).map((x) => x.name));
  return requiredMantleRefFields(s.schema).find((r) => names.has(r.collection))?.field;
}

/** @internal Whether a Schema has its own sidebar entry: not a translation, and top-level or an opt-in standalone child (Admin's `isPrimaryNavCollection` agrees). */
export function isPrimaryCollection(s: PlanSchema, schemas: readonly PlanSchema[]): boolean {
  const c = collectionOf(s, schemas);
  return !s.translates && (!c.parent || c.nav !== null);
}
