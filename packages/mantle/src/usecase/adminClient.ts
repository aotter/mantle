/** `admin-client.ts`: the types and tool names Admin's data hooks bind to, for the application's browser-side `admin.tsx`. */
import { mcpTools, type JsonSchema, type RuntimePlan } from "../build/compiler.js";
import { q } from "../domain/entry.js";

type TypeOf = (schema: JsonSchema | undefined) => string;

/** A Schema, View input or Procedure input as a closed object type; one that is only a `$ref` stays open. */
const closed = (typeOf: TypeOf, schema: JsonSchema | undefined): string =>
  !schema ? "{}" : schema.properties || schema.type === "object" && !schema["$ref"] ? typeOf({ ...schema, additionalProperties: false }) : "{ readonly [key: string]: unknown }";

/**
 * Types are what the routes take and return, not the Store's rows: an entry's `data` keeps declared field names, an input is
 * what the route validates, a View row is its wire row. The file imports `generated/*` as types only, so nothing of the
 * Worker enters the browser bundle, and it is refused in the Worker's startup graph (`mantle bundle`).
 */
export function emitAdminClient(plan: RuntimePlan, typeOf: TypeOf): Record<string, string> {
  const tools = mcpTools(plan, "admin"), tool = (kind: string, source: string) => tools.find(t => t.kind === kind && t.source === source)?.name ?? null;
  const views = Object.entries(plan.views).filter(([, v]) => v.surface === "admin").sort(([a], [b]) => a < b ? -1 : 1);
  const operations = Object.entries(plan.procedures).filter(([name]) => tool("procedure", name)).sort(([a], [b]) => a < b ? -1 : 1);
  const schemas = Object.values(plan.schemas).sort((a, b) => a.name < b.name ? -1 : 1);
  const rows = views.map(([name], n) => `import type { WireRow as View${n}Row } from "./views/${encodeURIComponent(name)}.js";`);
  const sql = operations.some(([, p]) => "sql" in p.handler);
  return { "admin-client.ts": [
    "// Browser only: import this from src/admin.tsx, never from the Worker (`mantle bundle` refuses it there).",
    'import type { AdminMeta } from "@aotter/mantle-admin/app";',
    'import { createAdminHooks } from "@aotter/mantle-admin/hooks";',
    ...(sql ? ['import type { Output } from "@aotter/mantle/contracts";'] : []),
    ...rows,
    "",
    "/** The input and row of each admin View, the `data` of each collection's entries, and the input and output of each admin operation. */",
    "export interface AppAdminTypes {",
    `  readonly views: { ${views.map(([name, v], n) => `readonly ${q(name)}: { readonly input: ${closed(typeOf, v.input)}; readonly row: View${n}Row }`).join("; ")} };`,
    `  readonly collections: { ${schemas.map(s => `readonly ${q(s.name)}: { readonly data: ${s.translates ? typeOf(s.schema) : closed(typeOf, s.schema)} }`).join("; ")} };`,
    `  readonly operations: { ${operations.map(([name, p]) => `readonly ${q(name)}: { readonly input: ${closed(typeOf, p.input)}; readonly output: ${"sql" in p.handler ? "Output" : "unknown"} }`).join("; ")} };`,
    "}",
    "",
    "/** Pass to `defineAdmin(admin, { ... })`: names the admin MCP tool behind each View and operation. */",
    `export const admin: AdminMeta<AppAdminTypes> = { views: { ${views.map(([name]) => `${q(name)}: { tool: ${q(tool("view", name))} }`).join(", ")} }, operations: { ${operations.map(([name]) => `${q(name)}: { tool: ${q(tool("procedure", name))} }`).join(", ")} } };`,
    "",
    "const hooks = createAdminHooks<AppAdminTypes>();",
    "export const useView = hooks.useView;",
    "export const useEntries = hooks.useEntries;",
    "export const useEntry = hooks.useEntry;",
    "export const useOperation = hooks.useOperation;",
    "export const useCollectionTotal = hooks.useCollectionTotal;",
    "export const useMe = hooks.useMe;",
    "",
  ].join("\n") };
}
