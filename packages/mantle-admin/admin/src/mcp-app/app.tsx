import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createInteractionController, type InteractionController } from "@aotter/mantle-ui/controller";
import { OperationPanel } from "@aotter/mantle-ui";
import { SchemaFields, applyFieldEdits } from "@aotter/mantle-ui/kit";
import { useInteraction } from "@aotter/mantle-ui";
import {
  nativeTimestamp,
  propertyLabel,
  renderDataValue,
  resolveLocalizedText,
  timestampHint,
  withNativeSchema,
  type FieldSchema,
} from "@aotter/mantle-ui";
import {
  actionsFor,
  diagnosticsOf,
  hiddenInputs,
  idempotencyInputs,
  invokeTool,
  nextCursorOf,
  rowsOf,
  toolOf,
  type AppCatalog,
  type AppCatalogView,
  BARE_VIEW,
  type AppRowAction,
  type CallTool,
  type ToolResult,
} from "../../../src/app/bridge";
import { web, type HostApi } from "./postmessage";
import { cursorAfter, rowId, type ShownView } from "./app-tools";
import { useLoadMore } from "../lib/use-load-more";
import { Slot, useViewCellNames } from "../app/slots";
import type { CellProps } from "../app/slot-props";
import type { HostRequestOutcome } from "../app/hooks";
import { appLabels, type AppLabels } from "./locale";
import { csvText } from "../../../src/csv";

type Row = Readonly<Record<string, unknown>>;

/** A View column's label: its field's title in the host's language, the entry's own timestamps in the App's, else the name humanized, as Admin. */
function columnLabel(name: string, schema: FieldSchema | undefined, language: string, labels: AppLabels): string {
  const native = nativeTimestamp(name);
  return resolveLocalizedText(schema?.title, language) == null && native
    ? labels[native]
    : propertyLabel(name, schema, language);
}

/**
 * A value as the App shows it: a date-time in the host's language and time zone, an http(s) link opened through the host
 * (`ui/open-link`, as the sandbox blocks navigation), anything else as Admin shows it.
 */
export function appValue(
  schema: FieldSchema | undefined,
  value: unknown,
  language: string,
  timeZone?: string,
  openLink?: HostApi["openLink"],
): ReactNode {
  const time =
    timestampHint(schema) && typeof value === "number"
      ? value
      : schema?.format === "date-time" && typeof value === "string"
        ? Date.parse(value)
        : NaN;
  if (Number.isFinite(time)) {
    try {
      const text = new Intl.DateTimeFormat(language, {
        dateStyle: "short",
        timeStyle: "short",
        ...(timeZone ? { timeZone } : {}),
      }).format(time);
      return typeof value === "string" ? <time dateTime={value}>{text}</time> : text;
    } catch {
      // an unknown language tag: Admin's own formatting
    }
  }
  if (openLink && schema?.format === "uri" && typeof value === "string" && web(value)) {
    return (
      <a
        href={value}
        className="underline"
        onClick={event => {
          event.preventDefault();
          void openLink(value);
        }}
      >
        {value}
      </a>
    );
  }
  return renderDataValue(schema, value, language);
}

/** What a cell needs of the App around it, so the `cell:view:` slots' props stay the public ones. */
const CellEnv = createContext<{
  readonly language: string;
  readonly timeZone: string | undefined;
  readonly openLink: HostApi["openLink"] | undefined;
}>({ language: "en", timeZone: undefined, openLink: undefined });

/** The built-in cell: the value as the App shows it. */
function AppCell({ value, property }: CellProps): ReactNode {
  const { language, timeZone, openLink } = useContext(CellEnv);
  return appValue(property as FieldSchema | undefined, value, language, timeZone, openLink);
}

/** One column's value, through the application's `cell:view:` components for the View. */
function ViewCell({
  tool,
  column,
  row,
  property,
}: {
  tool: string | null;
  column: string;
  row: Row;
  property: FieldSchema | undefined;
}): ReactNode {
  const names = useViewCellNames(tool ?? "", column);
  return <Slot name={names} Default={AppCell} props={{ value: row[column], row, property }} />;
}

/**
 * The Mantle MCP App: a View tool's rows as Admin shows them, and one row action at a time through the shared controller.
 * What a View's columns are and which tools act on a row come from the catalog the server embedded; every read and write is a
 * server tool call through the host (`callServerTool`), under the caller's own MCP authorization. The App holds no
 * credentials, and opening it has no side effect.
 */
export function MantleApp(props: {
  readonly catalog: AppCatalog;
  /** The host: without its server tools the App only shows rows, it opens and refreshes nothing. */
  readonly host: HostApi;
  /** The View tool's result, as the host delivered it. */
  readonly result: ToolResult | null;
  /** The View tool's arguments, reused to refresh the rows and to re-read one. */
  readonly input: Readonly<Record<string, unknown>> | null;
  /** The tool the host says it called, when the result does not name it. */
  readonly hostTool?: string;
  /** The host cancelled the View call before a result arrived. */
  readonly cancelled?: boolean;
  /** The host's BCP 47 locale. */
  readonly locale?: string;
  /** The host's IANA time zone, for date-times. */
  readonly timeZone?: string;
  /**
   * The application's pages declared for a tool (`pages[].mcp`), by tool name: shown instead of a View's rows, or for a
   * Procedure's result, when the host's tool is theirs.
   */
  readonly pages?: Readonly<Record<string, ReactNode>>;
  /**
   * Asks the host for full screen, inside the click that calls it; absent unless the App is in the conversation and the
   * host may grant it. A row action calls it as it opens.
   */
  readonly expand?: () => void;
  /**
   * The conversation's height cap, with `expand`: the rows shown are as many as fit under it (at least one), and one
   * button under them opens the rest in full screen. The App never scrolls inside the conversation (Claude's design
   * guidelines: no nested scrolling, and a touch screen pans the conversation).
   */
  readonly maxHeight?: number;
}): ReactNode {
  const { call, capabilities } = props.host;
  const openLink = capabilities.openLinks ? props.host.openLink : undefined;
  const labels = appLabels(props.locale);
  const language = props.locale ?? "en";
  const tool = props.result ? toolOf(props.result, props.hostTool) : null;
  // a View the catalog does not describe still shows its rows, with nothing to open
  const view =
    tool && Object.prototype.hasOwnProperty.call(props.catalog.views, tool) ? props.catalog.views[tool]! : BARE_VIEW;
  const [pages, dispatch] = useReducer(pagesReducer, undefined, () =>
    pagesReducer(NO_PAGES, { type: "reset", result: props.result }),
  );
  const { rows, cursor, more } = pages;
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<{ row: Row; action: AppRowAction } | null>(null);
  // the row the model asked to see (`view_focus`); a new object each time, so asking again scrolls again
  const [focused, setFocused] = useState<{ id: string } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // How many rows fit under the cap, measured for these rows, this cap and this width; null shows every row. A new
  // measurement renders every row first, before the browser paints.
  const [fit, setFit] = useState<{ rows: unknown; cap: unknown; width: number; limit: number | null } | null>(null);
  const [width, setWidth] = useState(() =>
    typeof document === "undefined" ? 0 : document.documentElement.clientWidth,
  );
  // The document's size changes with no render of its own too (a host font that arrives late, an image in a cell): each
  // change renders again, so a new width measures again and content grown past the cap shows one row fewer.
  const [, resized] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      setWidth(root.clientWidth);
      resized();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const cap = props.expand ? props.maxHeight : undefined;
  const measured = fit !== null && fit.rows === rows && fit.cap === cap && fit.width === width;
  const limit = measured ? fit.limit : null;
  // the page Load more asked for last, as "generation:cursor"
  const asked = useRef<string | null>(null);
  useEffect(() => {
    dispatch({ type: "reset", result: props.result });
    setStale(false);
    setFocused(null);
  }, [props.result]);
  // a row past the cap is scrolled to once it shows, in full screen
  useEffect(() => {
    const index = focused && rows ? rows.findIndex(row => rowId(row) === focused.id) : -1;
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [focused, limit]);
  useLayoutEffect(() => {
    const items = list.current?.children,
      last = end.current;
    if (cap === undefined || !items?.length || !last) return;
    const root = document.documentElement,
      top = root.getBoundingClientRect().top,
      padding = parseFloat(getComputedStyle(root).paddingBottom) || 0;
    // the document's height if it ended at this element's bottom: the root's own height may still be full screen's
    const bottom = (element: Element) => element.getBoundingClientRect().bottom - top + padding;
    const height = bottom(last);
    if (!measured) {
      let count = items.length;
      if (height > cap) {
        const below = height - bottom(items[items.length - 1]!);
        count = 1;
        while (count < items.length && bottom(items[count]!) + below <= cap) count++;
      }
      setFit({ rows, cap, width, limit: count < items.length ? count : null });
    } else if (limit !== null && limit > 1 && height > cap) {
      // the button under the rows is taller than what the measurement counted below them
      setFit({ rows, cap, width, limit: limit - 1 });
    }
  });

  const refresh = async () => {
    if (!tool || !call) return;
    try {
      const result = await call(tool, { ...props.input });
      const fresh = rowsOf(result) !== null;
      if (fresh) dispatch({ type: "reset", result });
      setStale(!fresh);
    } catch {
      setStale(true);
    }
  };

  // the same View tool and input through the host, at the cursor of the page shown last; the rows already shown stay.
  // Only the button's start() announces the rows added: rows view_more loads were asked for by the model, not the person.
  // The page is marked as asked for before the call: a second ask in the same task (parallel view_more calls, the button)
  // still sees the last render's state, so it is refused here. A failed or cancelled read can be asked for again.
  const nextPage = `${pages.generation}:${cursor}`;
  const loadMore = async (signal?: AbortSignal) => {
    if (!tool || !call || !cursor || asked.current === nextPage) return null;
    asked.current = nextPage;
    const { generation } = pages;
    dispatch({ type: "loading" });
    const result = await call(tool, { ...props.input, cursor }, signal).catch(() => null);
    dispatch(result ? { type: "loaded", generation, result } : { type: "failed", generation });
    if ((!result || !rowsOf(result)) && asked.current === nextPage) asked.current = null;
    return result;
  };

  const page =
    tool && props.pages && Object.prototype.hasOwnProperty.call(props.pages, tool) ? props.pages[tool] : undefined;
  // what the App's own tools read: the rows while they are on screen, not under a page or a row action
  const shown = useRef<ShownView | null>(null);
  useEffect(() => {
    shown.current =
      rows && page === undefined && !(open && tool && call)
        ? {
            tool,
            input: props.input ?? {},
            rows,
            cursor,
            get loading() {
              return asked.current === nextPage;
            },
            generation: pages.generation,
            ...(call ? { loadMore } : {}),
            focus: id => {
              if (!rows.some(row => rowId(row) === id)) return false;
              setFocused({ id });
              return true;
            },
            ...(limit !== null ? { inline: limit } : {}),
          }
        : null;
  });
  useEffect(() => {
    props.host.serveTools(() => shown.current);
    return () => props.host.serveTools(undefined);
  }, [props.host]);

  if (!props.result)
    return (
      <p className="text-muted-foreground p-4 text-sm">{props.cancelled ? labels.viewCancelled : labels.waiting}</p>
    );
  // a Procedure's result has no rows: its page is shown for any result that is not a failure
  if (!rows && page !== undefined && !props.result.isError) return <div data-slot="app-page">{page}</div>;
  if (!rows) {
    const failure = diagnosticsOf(props.result)[0]?.message;
    return (
      <div role="alert" className="grid gap-1 p-4 text-sm">
        <p className="text-destructive font-medium">{labels.viewFailed}</p>
        {failure ? <p className="text-muted-foreground">{failure}</p> : null}
      </div>
    );
  }
  if (open && tool && call) {
    return (
      <RowAction
        key={`${open.action.capability}:${String(open.row["id"])}`}
        call={call}
        row={open.row}
        action={open.action}
        labels={labels}
        locale={props.locale}
        onClose={() => setOpen(null)}
        onDone={() => {
          void refresh();
        }}
        // the model reads the change at its next turn; the App never speaks for the user (`ui/message`)
        onSucceeded={() => {
          void props.host.updateModelContext({
            content: [{ type: "text", text: `${open.action.capability} succeeded on row ${String(open.row["id"])}.` }],
            structuredContent: { tool: open.action.capability, id: String(open.row["id"]), outcome: "succeeded" },
          });
        }}
      />
    );
  }
  // the page reads its own data through the hooks, so a View's rows are not shown beside it
  if (page !== undefined) return <div data-slot="app-page">{page}</div>;
  const notice = stale ? (
    <p role="status" className="text-destructive px-3 pt-3 text-sm">
      {labels.refreshFailed}
    </p>
  ) : null;
  if (rows.length === 0)
    return (
      <>
        {notice}
        <p className="text-muted-foreground p-4 text-sm">{labels.nothing}</p>
      </>
    );
  const columns = columnsOf(view, rows);
  return (
    <CellEnv.Provider value={{ language, timeZone: props.timeZone, openLink }}>
      {notice}
      {capabilities.downloadFile && tool ? (
        <ExportRows
          labels={labels}
          onExport={() => props.host.downloadFile(`${tool}.csv`, csvText(columns, rows), "text/csv")}
        />
      ) : null}
      <ul ref={list} data-slot="app-rows" className="grid gap-2 p-3">
        {(limit === null ? rows : rows.slice(0, limit)).map((row, index) => {
          const id = typeof row["id"] === "string" ? row["id"] : undefined;
          const actions = call ? actionsFor(props.catalog, view, row) : [];
          return (
            <li
              key={id ?? index}
              aria-current={focused && rowId(row) === focused.id ? "true" : undefined}
              className="aria-[current=true]:ring-ring grid gap-2 rounded-md border p-3 text-sm aria-[current=true]:ring-2"
            >
              <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
                {columns.map(field => (
                  <div key={field} className="contents">
                    <dt className="text-muted-foreground">
                      {columnLabel(field, view.columns[field], language, labels)}
                    </dt>
                    <dd className="break-words">
                      <ViewCell
                        tool={tool}
                        column={field}
                        row={row}
                        property={withNativeSchema(field, view.columns[field])}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
              {actions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {actions.map(action => {
                    const title = resolveLocalizedText(action.title, language) ?? action.capability;
                    return (
                      <button
                        key={action.capability}
                        type="button"
                        // Every row repeats the same buttons; name the row too.
                        aria-label={id ? `${title}: ${id}` : undefined}
                        className="rounded-md border px-3 py-1 font-medium"
                        onClick={() => {
                          // a form is no inline content: full screen, asked within this click; it opens either way
                          props.expand?.();
                          setOpen({ row: { ...row }, action });
                        }}
                      >
                        {title}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {limit !== null ? (
        <div className="px-3 pb-3">
          <button type="button" className="rounded-md border px-3 py-1 text-sm font-medium" onClick={props.expand}>
            {labels.moreRows.replace("{count}", `${rows.length - limit}${cursor !== undefined ? "+" : ""}`)}
          </button>
        </div>
      ) : call ? (
        <MoreRows
          count={rows.length}
          hasMore={cursor !== undefined}
          more={more}
          labels={labels}
          onMore={() => {
            void loadMore();
          }}
        />
      ) : null}
      {/* where the App's content ends, whatever height the root has */}
      <div ref={end} />
    </CellEnv.Provider>
  );
}

/** The rows shown, the cursor of the next page, and how loading it went; `generation` counts the lists the App has shown. */
export interface Pages {
  readonly rows: Row[] | null;
  readonly cursor: string | undefined;
  readonly more: "idle" | "loading" | "failed";
  readonly generation: number;
}
const NO_PAGES: Pages = { rows: null, cursor: undefined, more: "idle", generation: 0 };
type PagesAction =
  | { readonly type: "reset"; readonly result: ToolResult | null }
  | { readonly type: "loading" }
  | { readonly type: "loaded"; readonly generation: number; readonly result: ToolResult }
  | { readonly type: "failed"; readonly generation: number };

/** A new or refreshed result replaces the list and ends any load in flight: its page, when it arrives, is for a list that is gone. */
export function pagesReducer(state: Pages, action: PagesAction): Pages {
  if (action.type === "reset")
    return {
      rows: action.result ? rowsOf(action.result) : null,
      cursor: action.result ? nextCursorOf(action.result) : undefined,
      more: "idle",
      generation: state.generation + 1,
    };
  if (action.type === "loading") return { ...state, more: "loading" };
  if (action.generation !== state.generation) return state;
  if (action.type === "failed") return { ...state, more: "failed" };
  const next = rowsOf(action.result);
  return next
    ? {
        ...state,
        rows: [...(state.rows ?? []), ...next],
        cursor: cursorAfter(state.cursor, action.result),
        more: "idle",
      }
    : { ...state, more: "failed" };
}

/** "Load more" under the rows: busy while loading; `useLoadMore` announces the rows added and keeps focus. */
function MoreRows(props: {
  readonly count: number;
  readonly hasMore: boolean;
  readonly more: Pages["more"];
  readonly labels: AppLabels;
  readonly onMore: () => void;
}): ReactNode {
  const { box, status, start } = useLoadMore({
    count: props.count,
    hasMore: props.hasMore,
    loading: props.more === "loading",
    message: added => props.labels.rowsLoaded.replace("{count}", String(added)),
  });
  return (
    <div
      ref={box}
      tabIndex={-1}
      aria-busy={props.more === "loading"}
      className="grid justify-items-start gap-2 px-3 pb-3 outline-none"
    >
      <span role="status" className="sr-only">
        {status}
      </span>
      {props.more === "failed" ? (
        <p role="alert" className="text-destructive text-sm">
          {props.labels.loadMoreFailed}
        </p>
      ) : null}
      {props.hasMore ? (
        <button
          type="button"
          className="rounded-md border px-3 py-1 text-sm font-medium"
          disabled={props.more === "loading"}
          onClick={() => {
            start();
            props.onMore();
          }}
        >
          {props.labels.loadMore}
        </button>
      ) : null}
    </div>
  );
}

/** "Export CSV": the rows the App holds, with the columns shown, saved through the host; no server call. */
function ExportRows(props: {
  readonly labels: AppLabels;
  readonly onExport: () => Promise<HostRequestOutcome>;
}): ReactNode {
  // `accepted` says no more than the host took the request, so it shows nothing; `unknown` is not reported as a failure
  const [state, setState] = useState<"idle" | "pending" | HostRequestOutcome>("idle");
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
      <button
        type="button"
        className="rounded-md border px-3 py-1 text-sm font-medium"
        disabled={state === "pending"}
        onClick={() => {
          setState("pending");
          void props.onExport().then(setState);
        }}
      >
        {props.labels.exportCsv}
      </button>
      <span
        role="status"
        className={state === "refused" ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
      >
        {state === "refused" ? props.labels.exportFailed : state === "unknown" ? props.labels.exportUnconfirmed : null}
      </span>
    </div>
  );
}

/** The View's declared list columns, else what the rows carry but the id and version, as Admin's report shows them. */
function columnsOf(view: AppCatalogView, rows: readonly Row[]): string[] {
  if (view.list.columns.length) return [...view.list.columns];
  return [...new Set(rows.flatMap(row => Object.keys(row)))]
    .filter(field => field !== "id" && field !== "version")
    .slice(0, 6);
}

function RowAction(props: {
  readonly call: CallTool;
  readonly row: Readonly<Record<string, unknown>>;
  readonly action: AppRowAction;
  readonly labels: AppLabels;
  readonly locale: string | undefined;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onSucceeded: () => void;
}): ReactNode {
  const automatic = idempotencyInputs(props.action);
  // Created once when the action is opened, from the row as it was then: a
  // refresh of the list never rebuilds it or points it at another entry.
  const [created] = useState((): { controller: InteractionController } | { error: unknown } => {
    const { call, row, action } = props;
    try {
      return {
        controller: createInteractionController({
          interaction: action,
          row,
          // the row as listed is the reviewed entry: a version that moved since is the server's CONFLICT, and the person
          // reopens the action from the refreshed list
          invoke: (values, signal) => invokeTool(call, action.capability, values, signal),
          // One key per opened action, so a retry after an uncertain write reuses it.
          initialInput: Object.fromEntries(automatic.map(field => [field, crypto.randomUUID()])),
          automatic,
        }),
      };
    } catch (error) {
      return { error };
    }
  });
  if ("error" in created) {
    return (
      <p role="alert" className="text-destructive p-4 text-sm">
        {String(created.error)}
      </p>
    );
  }
  return <RowActionPanel {...props} controller={created.controller} automatic={automatic} />;
}

function RowActionPanel(props: {
  readonly action: AppRowAction;
  readonly controller: InteractionController;
  readonly automatic: readonly string[];
  readonly labels: AppLabels;
  readonly locale: string | undefined;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onSucceeded: () => void;
}): ReactNode {
  const { action, controller } = props;
  const state = useInteraction(controller);
  const submitted = useRef(false);
  const refreshed = useRef(false);
  useEffect(() => {
    void controller.open();
  }, [controller]);
  useEffect(() => {
    if (state.phase === "submitting") submitted.current = true;
    if (state.phase === "succeeded" && !refreshed.current) {
      refreshed.current = true;
      props.onDone();
      props.onSucceeded();
    }
    // A refused or conflicting payload is a new operation next time.
    if (state.phase === "failed" || state.phase === "conflict") {
      for (const field of props.automatic) controller.edit(field, crypto.randomUUID());
    }
  }, [state.phase]);
  const close = () => {
    if (state.phase !== "succeeded" && state.phase !== "cancelled") controller.cancel();
    if (submitted.current && !refreshed.current) {
      refreshed.current = true;
      props.onDone();
    }
    props.onClose();
  };
  const language = props.locale ?? "en";
  const properties = (action.inputSchema.properties ?? {}) as Readonly<Record<string, FieldSchema>>;
  // a Procedure's inputs are its own: a field named created_at is not the entry's timestamp
  const fieldLabel = (field: string) => propertyLabel(field, properties[field], language);
  // the form's own zone: a native date input reads and writes the iframe's local time
  const fieldValue = (field: string, value: unknown) => renderDataValue(properties[field], value, language);
  const hidden = hiddenInputs(action);
  const visible = Object.keys(properties).some(name => !hidden.includes(name));
  return (
    // room for a Select's list or the date picker, which open over the panel inside the host's frame
    <div className="min-h-[28rem] p-3">
      <OperationPanel
        controller={controller}
        title={resolveLocalizedText(action.title, language) ?? action.capability}
        labels={props.labels.interaction}
        fieldLabel={fieldLabel}
        fieldValue={fieldValue}
        onClose={close}
        onCancel={close}
      >
        {/* Admin's own form: option titles, money and date previews, a field's widget from the Procedure's uiSchema */}
        {visible ? (
          <SchemaFields
            schema={action.inputSchema as FieldSchema}
            uiSchema={action.uiSchema ?? null}
            value={state.draft}
            onChange={next => applyFieldEdits(controller, state.draft, next)}
            language={language}
            hiddenRootFields={hidden}
            labels={props.labels.fields}
          />
        ) : null}
      </OperationPanel>
    </div>
  );
}
