/** `admin-client.ts`: the types Admin's data hooks bind to, for the application's browser-side `admin.tsx`. */
import { BUILT_IN_NAV_GROUPS, mcpTools, type JsonSchema, type RuntimePlan } from "../build/compiler.js";
import { q } from "../domain/entry.js";

type TypeOf = (schema: JsonSchema | undefined) => string;

/** A Schema, View input or Procedure input as a closed object type; one that is only a `$ref` stays open. */
const closed = (typeOf: TypeOf, schema: JsonSchema | undefined): string =>
  !schema ? "{}" : schema.properties || schema.type === "object" && !schema["$ref"] ? typeOf({ ...schema, additionalProperties: false }) : "{ readonly [key: string]: unknown }";

/**
 * Types are what the routes take and return, not the Store's rows: an entry's `data` keeps declared field names, an input is
 * what the route validates, a View row is its wire row under the names the browser route gives its columns (an MCP App's
 * `tools/call` returns the SQL names; the hooks rename them with `rowNames`). The file imports `generated/*` as types only, so nothing of the
 * Worker enters the browser bundle, and it is refused in the Worker's startup graph (`mantle bundle`).
 */
export function emitAdminClient(plan: RuntimePlan, typeOf: TypeOf, declared: readonly string[] = []): Record<string, string> {
  const tools = mcpTools(plan, "admin"), hasTool = (kind: string, source: string) => tools.some(t => t.kind === kind && t.source === source);
  const views = Object.entries(plan.views).filter(([, v]) => v.surface === "admin").sort(([a], [b]) => a < b ? -1 : 1);
  const operations = Object.entries(plan.procedures).filter(([name]) => hasTool("procedure", name)).sort(([a], [b]) => a < b ? -1 : 1);
  const schemas = Object.values(plan.schemas).sort((a, b) => a.name < b.name ? -1 : 1);
  // the scope column belongs to the caller, so an entry's data has no such field
  const dataOf = (s: (typeof schemas)[number]) => {
    const scope = s.scope ? s.names[s.scope] ?? s.scope : undefined, { [scope ?? ""]: _scope, ...properties } = s.schema.properties ?? {};
    // a draft of a publishing collection is only partly validated, so none of its fields is certain to be there
    const required = s.publishing ? [] : s.schema.required?.filter(f => f !== scope);
    const schema = { ...s.schema, properties, ...(required ? { required } : {}) };
    return s.translates ? typeOf(schema) : closed(typeOf, schema);
  };
  // the names the browser route gives a View's columns where they differ from the SQL output names, as it applies them
  const renames = views.map(([, v]) => Object.fromEntries(Object.entries(v.columns ?? {}).flatMap(([key, c]) => {
    const named = key === c.field ? plan.schemas[c.schema]!.names[c.field] ?? key : key;
    return named !== key ? [[key, named]] : [];
  })));
  // every sidebar group an admin Schema or View places an item in; `defineAdmin` must declare the ones Admin does not have
  // (the generate-time check of `uiSchema.nav.group` is this type), except those the legacy `navGroups` module declares
  const placed = (ui: Readonly<Record<string, unknown>> | undefined): string[] => { const group = (ui?.["nav"] as { group?: unknown } | undefined)?.group; return typeof group === "string" ? [group] : []; };
  const used = [...new Set([...schemas.flatMap(s => placed(s.uiSchema)), ...views.flatMap(([, v]) => placed(v.uiSchema))])].sort();
  const custom = used.filter(group => !BUILT_IN_NAV_GROUPS.has(group));
  const union = (names: readonly string[]) => names.length ? names.map(name => q(name)).join(" | ") : "never";
  const rows = views.map(([name], n) => `import type { WireRow as View${n}Wire } from "./views/${encodeURIComponent(name)}.js";`);
  const sql = operations.some(([, p]) => "sql" in p.handler);
  return { "admin-client.ts": [
    "// Browser only: import this from src/admin.tsx, never from the Worker (`mantle bundle` refuses it there).",
    'import type { AdminMeta } from "@aotter/mantle-admin/app";',
    'import { createAdminHooks } from "@aotter/mantle-admin/hooks";',
    ...(sql ? ['import type { Output } from "@aotter/mantle/contracts";'] : []),
    ...rows,
    "",
    "type Renamed<Row, Names extends { readonly [from: string]: string }> = { [K in keyof Row as K extends keyof Names ? Names[K] : K]: Row[K] };",
    ...views.map((_, n) => `type View${n}Row = Renamed<View${n}Wire, ${q(renames[n])}>;`),
    "",
    "/** Every sidebar group the manifest places an item in. */",
    `export type ManifestNavGroup = ${union(used)};`,
    "",
    "/** The input and row of each admin View, the `data` of each collection's entries, and the input and output of each admin operation. */",
    "export interface AppAdminTypes {",
    `  readonly views: { ${views.map(([name, v], n) => `readonly ${q(name)}: { readonly input: ${closed(typeOf, v.input)}; readonly row: View${n}Row }`).join("; ")} };`,
    `  readonly collections: { ${schemas.map(s => `readonly ${q(s.name)}: { readonly data: ${dataOf(s)} }`).join("; ")} };`,
    `  readonly operations: { ${operations.map(([name, p]) => `readonly ${q(name)}: { readonly input: ${closed(typeOf, p.input)}; readonly output: ${"sql" in p.handler ? "Output" : "unknown"} }`).join("; ")} };`,
    `  readonly navGroups: ${union(custom)};`,
    `  readonly requiredNavGroups: ${union(custom.filter(group => !declared.includes(group)))};`,
    "}",
    "",
    "/** Pass to `defineAdmin(admin)`: the column names a View's rows carry in the browser, for an MCP App to match. */",
    `export const admin: AdminMeta<AppAdminTypes> = { rowNames: ${q(Object.fromEntries(views.flatMap(([name], n) => Object.keys(renames[n]!).length ? [[name, renames[n]]] : [])))} };`,
    "",
    "export const { useView, useEntries, useEntry, useOperation, useCollectionTotal, useMe } = createAdminHooks<AppAdminTypes>();",
    "",
  ].join("\n") };
}
