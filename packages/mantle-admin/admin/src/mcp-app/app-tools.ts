import type { App } from "@modelcontextprotocol/ext-apps";
import { nextCursorOf, rowsOf, type ToolResult } from "../../../src/app/bridge";

type Row = Readonly<Record<string, unknown>>;
/** A `tools/list` entry, as the official App types it. */
type AppTool = Awaited<ReturnType<NonNullable<App["onlisttools"]>>>["tools"][number];

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

/** The View's rows as the App shows them; the App answers null while it shows no rows (waiting, a page or a row action). */
export interface ShownView {
  readonly tool: string | null;
  readonly input: Readonly<Record<string, unknown>>;
  readonly rows: readonly Row[];
  /** A next page exists. */
  readonly more: boolean;
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
 */
export function rowId(row: Row): string | undefined {
  const id = row["id"];
  return typeof id === "string" ? id : typeof id === "number" && Number.isFinite(id) ? String(id) : undefined;
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
 */
export async function callAppTool(
  read: () => ShownView | null,
  name: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AppToolResult> {
  if (!APP_TOOLS.some(tool => tool.name === name)) return text(`Unknown tool: ${name}`, true);
  const view = read();
  if (!view) return text("The App shows no View's rows now.", true);
  if (name === "view_state") return state(view, view.rows, view.more);
  if (name === "view_focus") {
    const id = args["id"];
    return typeof id === "string" && view.focus(id)
      ? text(`Showing row ${id}.`)
      : text("No row shown has this id; view_state lists them.", true);
  }
  if (!view.loadMore || !view.tool) return text("This host cannot load more rows in the App.", true);
  if (!view.more) return text("The View has no more rows.", true);
  if (view.loading) return text("The App is loading more rows already.", true);
  const result = await view.loadMore(signal);
  const added = result && rowsOf(result);
  if (!added) return text("Could not load more rows.", true);
  // a new or refreshed result while the page loaded: the page was for a list that is gone
  if ((read()?.generation ?? view.generation) !== view.generation)
    return text("The View was replaced; call view_state.", true);
  return state(view, [...view.rows, ...added], nextCursorOf(result) !== undefined);
}
