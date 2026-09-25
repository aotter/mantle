import { useEffect, useRef, useState, type ReactNode } from "react";
import { createInteractionController, type InteractionController } from "../controller/index.js";
import { OperationPanel } from "../react/components.js";
import { SchemaForm, schemaText } from "../react/schema-form.js";
import { useInteraction } from "../react/use-interaction.js";
import {
  diagnosticsOf,
  hiddenInputs,
  idempotencyInputs,
  invokeTool,
  readEntry,
  viewOf,
  type AppRowAction,
  type AppView,
  type CallTool,
  type ToolResult,
} from "./bridge.js";
import { appLabels, type AppLabels } from "./locale.js";

/**
 * The Mantle MCP App: a View's rows, and one row action at a time through
 * the shared controller. Every read and write is a server tool call through
 * the host (`callServerTool`), under the caller's own MCP authorization; the
 * App holds no credentials and opening it has no side effect.
 */
export function InteractionApp(props: {
  readonly call: CallTool;
  /** The View tool's result, as the host delivered it. */
  readonly result: ToolResult | null;
  /** The View tool's arguments, reused to refresh the rows. */
  readonly input: Readonly<Record<string, unknown>> | null;
  /** The host cancelled the View call before a result arrived. */
  readonly cancelled?: boolean;
  /** The host's BCP 47 locale. */
  readonly locale?: string;
}): ReactNode {
  const labels = appLabels(props.locale);
  const [view, setView] = useState<AppView | null>(() => (props.result ? viewOf(props.result) : null));
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<{ row: Readonly<Record<string, unknown>>; action: AppRowAction } | null>(null);
  useEffect(() => {
    setView(props.result ? viewOf(props.result) : null);
    setStale(false);
  }, [props.result]);

  const refresh = async () => {
    if (!view) return;
    try {
      const next = await props.call(view.view, { ...props.input });
      const fresh = viewOf(next);
      if (fresh) setView(fresh);
      setStale(!fresh);
    } catch {
      setStale(true);
    }
  };

  if (!view) {
    if (props.result) {
      const failure = diagnosticsOf(props.result)[0]?.message;
      return (
        <div role="alert" className="grid gap-1 p-4 text-sm">
          <p className="text-destructive font-medium">{labels.viewFailed}</p>
          {failure ? <p className="text-muted-foreground">{failure}</p> : null}
        </div>
      );
    }
    return <p className="text-muted-foreground p-4 text-sm">{props.cancelled ? labels.viewCancelled : labels.waiting}</p>;
  }
  if (open && view.collection) {
    return (
      <RowAction
        key={`${open.action.capability}:${open.action.bind.map(({ input }) => input).join(",")}:${String(open.row["id"])}`}
        call={props.call}
        collection={view.collection}
        read={view.read}
        row={open.row}
        action={open.action}
        labels={labels}
        locale={props.locale}
        onClose={() => setOpen(null)}
        onDone={() => { void refresh(); }}
      />
    );
  }
  const notice = stale ? <p role="status" className="text-destructive px-3 pt-3 text-sm">{labels.refreshFailed}</p> : null;
  if (view.rows.length === 0) return <>{notice}<p className="text-muted-foreground p-4 text-sm">{labels.nothing}</p></>;
  const columns = [...new Set(view.rows.flatMap((row) => Object.keys(row)))].filter((field) => field !== "version").slice(0, 4);
  return (
    <>
      {notice}
      <ul data-slot="app-rows" className="grid gap-2 p-3">
        {view.rows.map((row, index) => {
          const id = typeof row["id"] === "string" ? row["id"] : undefined;
          return (
            <li key={id ?? index} className="grid gap-2 rounded-md border p-3 text-sm">
              <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3">
                {columns.map((field) => (
                  <div key={field} className="contents">
                    <dt className="text-muted-foreground">{field}</dt>
                    <dd className="break-words">{format(row[field])}</dd>
                  </div>
                ))}
              </dl>
              {view.rowActions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {view.rowActions.map((action) => {
                    const title = action.title ?? action.capability;
                    return (
                      <button
                        key={`${action.capability}:${action.bind.map(({ input }) => input).join(",")}`}
                        type="button"
                        // Every row repeats the same buttons; name the row too.
                        aria-label={id ? `${title}: ${id}` : undefined}
                        className="rounded-md border px-3 py-1 font-medium"
                        onClick={() => setOpen({ row: { ...row }, action })}
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
    </>
  );
}

function RowAction(props: {
  readonly call: CallTool;
  readonly collection: string;
  readonly read: string | null;
  readonly row: Readonly<Record<string, unknown>>;
  readonly action: AppRowAction;
  readonly labels: AppLabels;
  readonly locale: string | undefined;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const automatic = idempotencyInputs(props.action);
  // Created once when the action is opened, from the row as it was then: a
  // refresh of the list never rebuilds it or points it at another entry.
  const [created] = useState((): { controller: InteractionController } | { error: unknown } => {
    const { call, collection, read, row, action } = props;
    try {
      return {
        controller: createInteractionController({
          interaction: action,
          row,
          // Without a reader on this surface, the row as listed is the reviewed entry.
          ...(action.version && read
            ? { read: (signal: AbortSignal) => readEntry(call, read, collection, String(row["id"]), signal) }
            : {}),
          invoke: (values, signal) => invokeTool(call, action.capability, values, signal),
          // One key per opened action, so a retry after an uncertain write reuses it.
          initialInput: Object.fromEntries(automatic.map((field) => [field, crypto.randomUUID()])),
          automatic,
        }),
      };
    } catch (error) {
      return { error };
    }
  });
  if ("error" in created) {
    return <p role="alert" className="text-destructive p-4 text-sm">{String(created.error)}</p>;
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
}): ReactNode {
  const { action, controller } = props;
  const state = useInteraction(controller);
  const submitted = useRef(false);
  const refreshed = useRef(false);
  useEffect(() => { void controller.open(); }, [controller]);
  useEffect(() => {
    if (state.phase === "submitting") submitted.current = true;
    if (state.phase === "succeeded" && !refreshed.current) {
      refreshed.current = true;
      props.onDone();
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
  const properties = action.inputSchema.properties ?? {};
  const fieldLabel = (field: string) => schemaText(properties[field]?.title, props.locale) ?? field;
  return (
    <div className="p-3">
      <OperationPanel
        controller={controller}
        title={action.title ?? action.capability}
        labels={props.labels.interaction}
        fieldLabel={fieldLabel}
        onClose={close}
        onCancel={close}
      >
        <SchemaForm schema={action.inputSchema} controller={controller} state={state} hidden={hiddenInputs(action)} language={props.locale} />
      </OperationPanel>
    </div>
  );
}

function format(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
