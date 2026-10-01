/**
 * What an MCP App needs to show a surface's View tools the way Admin does (ADR-0029 D7): each View's columns as the Schema
 * fields they read, and the Procedure tools that act on one of its rows. It is built from the plan alone, carries no SQL and
 * no caller data, and is embedded in the App's HTML, so the App reads it without a tool call.
 */
import { NATIVE_OUTPUT_TYPES, mcpTools, type JsonSchema, type LocalizedText, type PlanView, type RuntimePlan } from "../spec/domain/index.js";
import type { McpAppResource } from "./apps.js";

/** A Procedure tool that acts on one row: `bind` feeds its id input from the row, `version` locks the row's version. */
export interface AppRowAction {
  readonly capability: string;
  readonly title?: LocalizedText;
  readonly inputSchema: JsonSchema;
  readonly bind: readonly { readonly input: string; readonly field: "id" }[];
  readonly version?: string;
  readonly mutates: true;
}

export interface AppCatalogView {
  readonly title?: LocalizedText;
  /** Output name → the field schema it reads, so a value is labelled and formatted as that field. */
  readonly columns: Readonly<Record<string, JsonSchema>>;
  /** `uiSchema.list.columns`, as Admin's report reads them. */
  readonly list: { readonly columns: readonly string[] };
  /** The `actions` a row of this View can open. */
  readonly actions: readonly string[];
}

export interface AppCatalog {
  /** View tool name → its View. */
  readonly views: Readonly<Record<string, AppCatalogView>>;
  /** Procedure tool name → how it acts on a row. */
  readonly actions: Readonly<Record<string, AppRowAction>>;
}

/** The catalog element's id in the App's HTML. */
export const APP_CATALOG_ID = "mantle-catalog";

/** The entry's own timestamps, as a View outputs them: date-times on the wire. */
const nativeSchema = (field: string): JsonSchema | undefined =>
  Object.hasOwn(NATIVE_OUTPUT_TYPES, field) ? ({ type: "string", format: "date-time" } as JsonSchema) : undefined;

type Target = { ResTarget: { name?: string; val?: { ColumnRef?: { fields?: { String?: { sval?: string } }[] } } } };

/**
 * The Schema whose entry a row's `id` is: the View reads one table and outputs that table's `id` unchanged. Anything else
 * (a join, a subquery in FROM, an `id` alias of another column) names no entry, so no operation is offered on its rows.
 */
function entrySchema(plan: RuntimePlan, v: PlanView): string | undefined {
  const sel = v.stmts[0]?.SelectStmt;
  const table = sel?.fromClause?.length === 1 ? sel.fromClause[0].RangeVar : undefined;
  const key = typeof table?.relname === "string" ? table.relname.toLowerCase() : undefined;
  if (!key || table.mantle !== "table" || !Object.hasOwn(plan.schemas, key)) return undefined;
  const outputsId = ((sel.targetList ?? []) as Target[]).some(({ ResTarget: r }) => {
    const col = r.val?.ColumnRef?.fields?.at(-1)?.String?.sval;
    return col === "id" && (r.name ?? col) === "id";
  });
  return outputsId ? key : undefined;
}

export function appCatalog(plan: RuntimePlan, surface: "public" | "staff"): AppCatalog {
  const tools = mcpTools(plan, surface);
  const actions: Record<string, AppRowAction> = {};
  const targets = new Map<string, string[]>();
  for (const t of tools) {
    const p = t.kind === "procedure" ? plan.procedures[t.source]! : undefined;
    if (!p?.target) continue;
    actions[t.name] = { capability: t.name, ...(p.title !== undefined ? { title: p.title } : {}), inputSchema: p.input, bind: [{ input: p.target.id, field: "id" }], ...(p.target.version ? { version: p.target.version } : {}), mutates: true };
    const key = p.target.schema.toLowerCase();
    targets.set(key, [...(targets.get(key) ?? []), t.name]);
  }
  const views: Record<string, AppCatalogView> = {};
  for (const tool of tools) {
    if (tool.kind !== "view") continue;
    const v = plan.views[tool.source]!;
    const columns: Record<string, JsonSchema> = {};
    for (const [k, c] of Object.entries(v.columns ?? {})) {
      const s = plan.schemas[c.schema]!;
      const field = s.names?.[c.field] ?? c.field;
      const property = (s.schema.properties as Record<string, JsonSchema> | undefined)?.[field] ?? nativeSchema(c.field);
      // named as the rows name it: a field read unchanged keeps its declared spelling
      if (property) columns[k === c.field ? field : k] = property;
    }
    const list = (v.uiSchema?.["list"] ?? {}) as { columns?: string[] };
    const entry = entrySchema(plan, v);
    views[tool.name] = { ...(v.title !== undefined ? { title: v.title } : {}), columns, list: { columns: list.columns ?? [] }, actions: entry ? targets.get(entry) ?? [] : [] };
  }
  return { views, actions };
}

/** The App's HTML with the catalog as a JSON script; `<` is escaped, so no value can close the element. */
export function withCatalog(html: string, catalog: AppCatalog): string {
  const script = `<script type="application/json" id="${APP_CATALOG_ID}">${JSON.stringify(catalog).replace(/</g, "\\u003c")}</script>`;
  // a function, so a `$` in the catalog is never read as a replacement pattern
  return html.includes("</head>") ? html.replace("</head>", () => `${script}</head>`) : script + html;
}

/**
 * One App for every View tool of a surface: `html` is the built App (`mantleAppHtml` from `@aotter/mantle-ui/mcp-app`), and
 * the plan's catalog is embedded once, when the surface is built. It describes what the plan offers, not what one caller may
 * do: an operation the caller's role cannot run is still offered, and the server refuses it as it refuses any tool call.
 */
export function planApp(plan: RuntimePlan, options: { readonly surface: "public" | "staff"; readonly html: string; readonly uri?: string; readonly title?: string }): McpAppResource {
  const catalog = appCatalog(plan, options.surface);
  return {
    uri: options.uri ?? `ui://mantle/${options.surface}`,
    name: `mantle-${options.surface}`,
    title: options.title ?? "Mantle",
    description: "A Mantle View's rows, and the operations that act on one row.",
    html: withCatalog(options.html, catalog),
    renders: Object.keys(catalog.views),
  };
}
