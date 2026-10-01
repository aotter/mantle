/**
 * What an MCP App needs to show a surface's View tools the way Admin does (ADR-0029 D7): each View's columns as the Schema
 * fields they read, and the Procedure tools that act on one of its rows. It is built from the plan alone, carries no SQL and
 * no caller data, and is embedded in the App's HTML, so the App reads it without a tool call.
 */
import { mcpTools, relationsOf, type JsonSchema, type LocalizedText, type RuntimePlan } from "../spec/domain/index.js";
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
  readonly rowActions: readonly AppRowAction[];
}

/** View tool name → its View. */
export interface AppCatalog {
  readonly views: Readonly<Record<string, AppCatalogView>>;
}

/** The catalog element's id in the App's HTML. */
export const APP_CATALOG_ID = "mantle-catalog";

const DATE_TIME: JsonSchema = { type: "string", format: "date-time" } as JsonSchema;
const NATIVE_TIMESTAMPS = new Set(["created_at", "updated_at"]);

export function appCatalog(plan: RuntimePlan, surface: "public" | "staff"): AppCatalog {
  const tools = mcpTools(plan, surface);
  const procedures = tools.filter((t) => t.kind === "procedure");
  const views: Record<string, AppCatalogView> = {};
  for (const tool of tools) {
    if (tool.kind !== "view") continue;
    const v = plan.views[tool.source]!;
    const columns: Record<string, JsonSchema> = {};
    // a row's id names an entry only when the View reads one Schema
    const reads = [...relationsOf(v.stmts).reads].filter((key) => Object.hasOwn(plan.schemas, key));
    const collection = reads.length === 1 ? reads[0] : undefined;
    for (const [k, c] of Object.entries(v.columns ?? {})) {
      const s = plan.schemas[c.schema]!;
      const field = s.names?.[c.field] ?? c.field;
      // named as the rows name it: a field read unchanged keeps its declared spelling
      const name = k === c.field ? field : k;
      const property = (s.schema.properties as Record<string, JsonSchema> | undefined)?.[field];
      if (property) columns[name] = property;
      else if (NATIVE_TIMESTAMPS.has(c.field)) columns[name] = DATE_TIME;
    }
    const list = (v.uiSchema?.["list"] ?? {}) as { columns?: string[] };
    // a Procedure acts on a row when it targets the Schema the row's id comes from
    const rowActions: AppRowAction[] = collection === undefined ? [] : procedures.flatMap((t) => {
      const p = plan.procedures[t.source]!;
      if (!p.target || p.target.schema.toLowerCase() !== collection) return [];
      return [{ capability: t.name, ...(p.title !== undefined ? { title: p.title } : {}), inputSchema: p.input, bind: [{ input: p.target.id, field: "id" as const }], ...(p.target.version ? { version: p.target.version } : {}), mutates: true as const }];
    });
    views[tool.name] = { ...(v.title !== undefined ? { title: v.title } : {}), columns, list: { columns: list.columns ?? [] }, rowActions };
  }
  return { views };
}

/** The App's HTML with the catalog as a JSON script; `<` is escaped, so no value can close the element. */
export function withCatalog(html: string, catalog: AppCatalog): string {
  const script = `<script type="application/json" id="${APP_CATALOG_ID}">${JSON.stringify(catalog).replace(/</g, "\\u003c")}</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : script + html;
}

/**
 * One App for every View tool of a surface: `html` is the built App (`mantleAppHtml` from `@aotter/mantle-ui/mcp-app`), and
 * the plan's catalog is embedded once, when the surface is built.
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
