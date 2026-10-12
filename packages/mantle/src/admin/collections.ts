/** Pure collection metadata, shared by Admin and the deployment compiler. */
import { MCP_HINT_KEYWORD, isMediaMcpHint, enumOptions, resolveMantleRef, type JsonSchema, type PlanSchema } from "../spec/domain/index.js";

type Props = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export const propsOf = (s: JsonSchema) => (s.properties ?? {}) as Props;

/** @internal What the SPA lists and edits for one Schema; a translation's parent is the entry sharing its `on`. */
export function collectionOf(s: PlanSchema, schemas: readonly PlanSchema[]) {
  const names = new Set(schemas.filter((x) => !x.translates).map((x) => x.name));
  const props = propsOf(s.schema);
  const required = new Set(s.schema.required ?? []);
  const ui = (s.uiSchema ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const list = ui["list"] ?? {};
  const nav = ui["nav"];
  const filterField = list["filterField"] as string | undefined;
  // a required reference is composition: the child sits under its parent, an `id` reference first, else one by a unique field
  const refs = Object.keys(props).filter((f) => required.has(f) && names.has(resolveMantleRef(props[f])?.schema ?? ""));
  const byId = refs.find((f) => resolveMantleRef(props[f])!.field === "id");
  const parentField = byId ?? refs[0];
  // a standalone list's parent picker scopes by the parent's entry id, so only an `id` reference composes there (the checker agrees)
  const navField = nav?.["standalone"] === true ? (nav["parentField"] as string | undefined) ?? byId : undefined;
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
    sortableFields: [...new Set([...(s.unique ?? []), ...(s.indexes ?? [])].map((i) => s.names[i[0]!] ?? i[0]!).filter((f) => required.has(f)))],
    filter: filterField ? { field: filterField, values: enumOptions(props[filterField])?.map((o) => o.value) ?? [] } : null,
    list: { primaryField: (list["primaryField"] as string | undefined) ?? null, columns: (list["columns"] as string[] | undefined) ?? [] },
    nav: navField && navParent ? { standalone: true, parentField: navField, parentCollection: navParent.schema } : null,
  };
}

