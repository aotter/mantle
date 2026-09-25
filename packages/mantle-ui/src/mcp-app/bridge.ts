import type { EntrySnapshot, InteractionDiagnostic, InvokeOutcome } from "../controller/index.js";
import type { FormSchema } from "../react/schema-form.js";

/** Result `_meta` key the Mantle MCP server fills for App-linked Views. */
export const INTERACTION_META_KEY = "net.aotter.mantle/interaction";

/** A row action as the server describes it in `_meta`. */
export interface AppRowAction {
  readonly capability: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: FormSchema;
  readonly bind: readonly { readonly input: string; readonly field: string }[];
  readonly version?: string;
  readonly mutates: boolean;
}

export interface AppView {
  /** Tool that produced the rows, called again to refresh them. */
  readonly view: string;
  readonly collection: string | null;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowActions: readonly AppRowAction[];
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

/** The View a tool result describes, or null for any other result. */
export function viewOf(result: ToolResult): AppView | null {
  const meta = result._meta?.[INTERACTION_META_KEY];
  if (!isRecord(meta) || typeof meta["view"] !== "string" || !Array.isArray(meta["rowActions"])) return null;
  const output = outputOf(result);
  const rows = isRecord(output) && Array.isArray(output["rows"]) ? output["rows"].filter(isRecord) : [];
  return {
    view: meta["view"],
    collection: typeof meta["collection"] === "string" ? meta["collection"] : null,
    rows,
    rowActions: meta["rowActions"] as AppRowAction[],
  };
}

/** `structuredContent`, else the JSON text block, else the text itself. */
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
  const output = outputOf(result);
  const diagnostics = isRecord(output) && Array.isArray(output["diagnostics"])
    ? output["diagnostics"].filter((item): item is InteractionDiagnostic =>
      isRecord(item) && typeof item["code"] === "string" && typeof item["message"] === "string")
    : [];
  if (diagnostics.length === 0) throw new Error(typeof output === "string" ? output : "The tool failed without a diagnostic.");
  return { ok: false, diagnostics };
}

/** `read_entry` for the row's entry, as the controller's snapshot. */
export async function readEntry(call: CallTool, collection: string, id: string, signal: AbortSignal): Promise<EntrySnapshot> {
  const result = await call("read_entry", { collection, id }, signal);
  if (result.isError) throw new Error("The entry could not be read.");
  const entry = outputOf(result);
  if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["version"] !== "number") {
    throw new Error("read_entry returned no entry version.");
  }
  return { id: entry["id"], version: entry["version"], data: isRecord(entry["data"]) ? entry["data"] : {} };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
