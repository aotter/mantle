import type { App } from "@modelcontextprotocol/ext-apps";
import { nextCursorOf, rowsOf, type ToolResult } from "../../../src/app/bridge";
import type { AdminAppTool } from "../app/hooks";

type Row = Readonly<Record<string, unknown>>;
/** A `tools/list` entry, as the official App types it. */
export type AppTool = Awaited<ReturnType<NonNullable<App["onlisttools"]>>>["tools"][number];

/**
 * The App's own tools ("app tools"), which a host may let the model call while the App is open. They are view-only: they
 * read the View the App shows, load its next page with the same read the "Load more" button makes, and scroll to a row.
 * None writes, runs an action, or shows anything the App does not already hold. Fixed definitions, so a host that asks
 * the person to approve app tools asks once.
 */
export const APP_TOOLS: AppTool[] = [
  {
    name: "view_state",
    title: "Read the open View",
    description:
      "What the open Mantle App shows: the View tool, its input, the ids of the rows shown and whether more rows exist.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "view_more",
    title: "Load more rows",
    description:
      "Loads the next page of the open View into the App, as its Load more button does, and answers as view_state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "view_focus",
    title: "Show a row",
    description: "Scrolls the open View to the row with this id, one of view_state's ids, and highlights it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, description: "A row id from view_state." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

/** The most result text a host takes from an app tool (Claude: 100,000 characters). */
export const APP_TOOL_TEXT_LIMIT = 100_000;

/**
 * How long `view_more` waits for its page. A host stops waiting for an app tool (Claude: 45 seconds, not counting the
 * person's approval) and tells the model the action might have happened; giving up first lets the tool answer instead.
 */
export const VIEW_MORE_DEADLINE = 40_000;

/** The View's rows as the App shows them; the App answers null while it shows no rows (waiting, a page or a row action). */
export interface ShownView {
  readonly tool: string | null;
  readonly input: Readonly<Record<string, unknown>>;
  readonly rows: readonly Row[];
  /** The next page's cursor; undefined when no next page exists. */
  readonly cursor: string | undefined;
  /** A next page is being loaded; read when a tool runs, as a load started in the same task is not rendered yet. */
  readonly loading: boolean;
  /** Counts the lists the App has shown; a page loaded for an earlier list is dropped. */
  readonly generation: number;
  /** "Load more": the View tool, its input and the next cursor. Absent where the host offers no server tools. */
  readonly loadMore?: (signal: AbortSignal) => Promise<ToolResult | null>;
  /** Scrolls to and highlights the row with this id; false when no row shown has it. */
  focus(id: string): boolean;
}

export type AppToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (value: string, isError = false): AppToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError } : {}),
});

/**
 * A row's id as the tools name it: a View may output a number as id (a GROUP BY key, say), named as text since view_focus
 * takes text. A row with any other id, or none, is shown and counted but cannot be named.
 * A number id and a string id with the same text (`7` and `"7"`) get the same name: view_state lists it twice, view_focus
 * shows the first and both are marked as shown.
 */
export function rowId(row: Row): string | undefined {
  const id = row["id"];
  return typeof id === "string" ? id : typeof id === "number" && Number.isFinite(id) ? String(id) : undefined;
}

/**
 * The cursor after a page read at `cursor`. A page whose next cursor is the one it was read at ends the list: reading it
 * again would answer the same page forever.
 */
export function cursorAfter(cursor: string | undefined, result: ToolResult): string | undefined {
  const next = nextCursorOf(result);
  return next === cursor ? undefined : next;
}

/** view_state's answer: as many row ids as fit the host's limit, marked `truncated` when some do not. */
function state(view: ShownView, rows: readonly Row[], more: boolean): AppToolResult {
  const ids = rows.flatMap(row => rowId(row) ?? []);
  const base = { tool: view.tool, input: view.input, rows: rows.length, more };
  let budget = APP_TOOL_TEXT_LIMIT - JSON.stringify({ ...base, ids: [], truncated: true }).length;
  // never cut the JSON: a View input over the limit on its own is an error, not a broken answer
  if (budget < 0) return text("The View's input is too large to report.", true);
  const shown: string[] = [];
  for (const id of ids) {
    budget -= JSON.stringify(id).length + 1;
    if (budget < 0) break;
    shown.push(id);
  }
  return text(JSON.stringify({ ...base, ids: shown, ...(shown.length < ids.length ? { truncated: true } : {}) }));
}

/**
 * Answers the host's `tools/call` for one of `APP_TOOLS`. `read` gives what the App shows now; the only server call is
 * `ShownView.loadMore`, the View tool's own read.
 * A host may hand the model an error result without its text (Claude does), so what the model can act on (no rows shown,
 * an id not shown, no next page, a page already loading, a list replaced) is a normal answer that says what was not done
 * and what to call instead. `isError` is kept for real failures: an unknown tool, an answer too large to give, a failed read.
 */
export async function callAppTool(
  read: () => ShownView | null,
  name: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AppToolResult> {
  if (!APP_TOOLS.some(tool => tool.name === name)) return text(`Unknown tool: ${name}`, true);
  const view = read();
  if (!view)
    return text(
      "The App shows no View's rows now (it waits for a result, or shows a page or a row action); nothing was done.",
    );
  if (name === "view_state") return state(view, view.rows, view.cursor !== undefined);
  if (name === "view_focus") {
    const id = args["id"];
    return typeof id === "string" && view.focus(id)
      ? text(`Showing row ${id}.`)
      : text("No row shown has this id; nothing was scrolled. Pass one of the ids view_state lists, as text.");
  }
  if (!view.loadMore || !view.tool) return text("This host cannot load more rows in the App; nothing was loaded.");
  if (view.cursor === undefined) return text("The View has no more rows; nothing was loaded.");
  if (view.loading) return text("The App is loading more rows already; call view_state once they are shown.");
  // a read: giving up only loses the page, which the model or the button can ask for again
  const result = await view.loadMore(AbortSignal.any([signal, AbortSignal.timeout(VIEW_MORE_DEADLINE)]));
  const added = result && rowsOf(result);
  if (!added) return text("Could not load more rows.", true);
  // a new or refreshed result while the page loaded: the page was for a list that is gone
  if ((read()?.generation ?? view.generation) !== view.generation)
    return text("The View was replaced while the page loaded, so the page was dropped; call view_state.");
  return state(view, [...view.rows, ...added], cursorAfter(view.cursor, result) !== undefined);
}

/** A host's limits on a view's tools (Claude's): checked when a page registers, as a host would reject them. */
const MAX_TOOLS = 64,
  MAX_DEFINITIONS = 1024 * 1024,
  MAX_SCHEMA = 64 * 1024,
  MAX_DEPTH = 32;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const depth = (value: unknown): number =>
  value !== null && typeof value === "object" ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0;

/**
 * A registration's tools as `tools/list` lists them after `APP_TOOLS` and the tools `registered` before: each definition
 * as JSON, so what is listed is what is measured. Throws on the first definition a host would reject, counting the limits
 * over the whole list.
 */
export function pageToolList(tools: readonly AdminAppTool[], registered: readonly AppTool[] = []): AppTool[] {
  const names = new Set(registered.map(tool => tool.name));
  const listed = tools.map(({ name, title, description, inputSchema, annotations }) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(name))
      throw new Error(`App tool name ${JSON.stringify(name)} must be 1 to 128 letters, digits, ".", "_" or "-".`);
    if (name.startsWith("view_")) throw new Error(`App tool name ${name}: "view_" names are the App's own tools.`);
    if (names.has(name)) throw new Error(`App tool name ${name} is registered twice.`);
    names.add(name);
    const tool = JSON.parse(JSON.stringify({ name, title, description, inputSchema, annotations })) as AppTool;
    if (tool.inputSchema?.type !== "object")
      throw new Error(`App tool ${name}: inputSchema must have type "object" at its root.`);
    if (bytes(tool.inputSchema) > MAX_SCHEMA || depth(tool.inputSchema) > MAX_DEPTH)
      throw new Error(`App tool ${name}: inputSchema must be at most 64 KiB as JSON and 32 levels deep.`);
    return tool;
  });
  if (APP_TOOLS.length + registered.length + listed.length > MAX_TOOLS)
    throw new Error(`A page registers at most ${MAX_TOOLS - APP_TOOLS.length} app tools in all.`);
  if (bytes([...APP_TOOLS, ...registered, ...listed]) > MAX_DEFINITIONS)
    throw new Error("App tool definitions must be at most 1 MiB as JSON.");
  return listed;
}

/** Runs a page tool's handler: the text it answers, or an error result with the message it threw. */
export async function callPageTool(
  tool: AdminAppTool,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AppToolResult> {
  try {
    const answer = await tool.handler(args, signal);
    return typeof answer === "string" ? text(answer) : text(`${tool.name} answered no text.`, true);
  } catch (error) {
    return text((error instanceof Error ? error.message : String(error)) || `${tool.name} failed.`, true);
  }
}
