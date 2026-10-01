import type { EntrySnapshot, InteractionDiagnostic, InvokeOutcome } from "../controller/index.js";
import type { FormSchema } from "../react/schema-form.js";
import type { FieldSchema, LocalizedText } from "../react/values.js";

/** Result `_meta` key naming the tool, on results an App renders (`@aotter/mantle/mcp`'s `APP_TOOL_META_KEY`). */
export const APP_TOOL_META_KEY = "net.aotter.mantle/tool";
/** The element the host embeds the catalog in (`@aotter/mantle/mcp`'s `APP_CATALOG_ID`). */
export const APP_CATALOG_ID = "mantle-catalog";

/** A Procedure tool that acts on one row, as `@aotter/mantle/mcp`'s `appCatalog` describes it. */
export interface AppRowAction {
  readonly capability: string;
  readonly title?: LocalizedText;
  readonly inputSchema: FormSchema;
  readonly bind: readonly { readonly input: string; readonly field: string }[];
  readonly version?: string;
  readonly mutates: boolean;
}

export interface AppCatalogView {
  readonly title?: LocalizedText;
  readonly columns: Readonly<Record<string, FieldSchema>>;
  readonly list: { readonly columns: readonly string[] };
  readonly rowActions: readonly AppRowAction[];
}

/** View tool name → its View: what the server embedded in the App's HTML. */
export interface AppCatalog {
  readonly views: Readonly<Record<string, AppCatalogView>>;
}

/** The shape every MCP tool result shares, independent of an SDK. */
export interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** Calls one server tool; the App passes `app.callServerTool`. */
export type CallTool = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;

type Row = Readonly<Record<string, unknown>>;

/** The catalog the host embedded; none is an empty catalog. */
export function readCatalog(doc: Pick<Document, "getElementById"> = document): AppCatalog {
  try {
    const parsed = JSON.parse(doc.getElementById(APP_CATALOG_ID)?.textContent ?? "") as unknown;
    if (isRecord(parsed) && isRecord(parsed["views"])) return parsed as unknown as AppCatalog;
  } catch {
    // no catalog: nothing to render with it
  }
  return { views: {} };
}

/** The tool a result came from: the server names it, else the host's tool info. */
export function toolOf(result: ToolResult, hostTool?: string): string | null {
  const named = result._meta?.[APP_TOOL_META_KEY];
  return typeof named === "string" ? named : hostTool ?? null;
}

/** A View result's rows; null for a failure or any other result. */
export function rowsOf(result: ToolResult): Row[] | null {
  if (result.isError) return null;
  const output = outputOf(result);
  return isRecord(output) && Array.isArray(output["rows"]) ? output["rows"].filter(isRecord) : null;
}

/** The diagnostics an `isError` result carries, from either content form. */
export function diagnosticsOf(result: ToolResult): InteractionDiagnostic[] {
  const output = outputOf(result);
  return isRecord(output) && Array.isArray(output["diagnostics"])
    ? output["diagnostics"].filter((item): item is InteractionDiagnostic =>
      isRecord(item) && typeof item["code"] === "string" && typeof item["message"] === "string")
    : [];
}

/**
 * `structuredContent`, else the JSON text block, else the text itself. A
 * tool with an output schema reports failures in the text block only.
 */
export function outputOf(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

/**
 * A tool answer as the controller reads it. `isError` results carry the
 * runtime's `{ diagnostics }`; a thrown call (transport, host, protocol) is
 * rethrown, so the controller treats the write as uncertain.
 */
export async function invokeTool(call: CallTool, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<InvokeOutcome> {
  const result = await call(name, args, signal);
  if (!result.isError) return { ok: true, data: outputOf(result) };
  const diagnostics = diagnosticsOf(result);
  if (diagnostics.length === 0) {
    const output = outputOf(result);
    throw new Error(typeof output === "string" ? output : "The tool failed without a diagnostic.");
  }
  return { ok: false, diagnostics };
}

/**
 * The row as it is now, for the controller's version check: the View tool is called again with the same input and the row
 * found by id. A row that left the list, or carries no version, cannot be reviewed.
 */
export async function readRow(call: CallTool, view: string, input: Readonly<Record<string, unknown>>, id: string, signal: AbortSignal, gone: string): Promise<EntrySnapshot> {
  const result = await call(view, { ...input }, signal);
  if (result.isError) throw new Error(diagnosticsOf(result)[0]?.message ?? gone);
  const row = rowsOf(result)?.find((r) => r["id"] === id);
  if (!row || typeof row["version"] !== "number") throw new Error(gone);
  return { id, version: row["version"], data: row };
}

/** Inputs the form does not render: row bindings, the version, idempotency keys. */
export function hiddenInputs(action: AppRowAction): string[] {
  return [
    ...action.bind.map(({ input }) => input),
    ...(action.version ? [action.version] : []),
    ...idempotencyInputs(action),
  ];
}

export function idempotencyInputs(action: AppRowAction): string[] {
  return Object.entries(action.inputSchema.properties ?? {})
    .filter(([, property]) => property["x-mcp-hint"] === "idempotency-key")
    .map(([name]) => name);
}

/** The row actions a row can open: it carries an id, and its version when the action locks one. */
export function actionsFor(view: AppCatalogView, row: Row): AppRowAction[] {
  if (typeof row["id"] !== "string") return [];
  return view.rowActions.filter((a) => !a.version || typeof row["version"] === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
