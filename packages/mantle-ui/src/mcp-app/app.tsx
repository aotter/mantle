import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createInteractionController } from "../controller/index.js";
import { OperationPanel } from "../react/components.js";
import { defaultInteractionLabels } from "../react/labels.js";
import { SchemaForm } from "../react/schema-form.js";
import { useInteraction } from "../react/use-interaction.js";
import {
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
}): ReactNode {
  const [view, setView] = useState<AppView | null>(() => (props.result ? viewOf(props.result) : null));
  const [open, setOpen] = useState<{ row: Readonly<Record<string, unknown>>; action: AppRowAction } | null>(null);
  useEffect(() => { setView(props.result ? viewOf(props.result) : null); }, [props.result]);

  const refresh = async () => {
    if (!view) return;
    const next = viewOf(await props.call(view.view, { ...props.input }));
    if (next) setView(next);
  };

  if (!view) return <p className="text-muted-foreground p-4 text-sm">Waiting for results…</p>;
  if (open && view.collection) {
    return (
      <RowAction
        key={`${open.action.capability}:${String(open.row["id"])}`}
        call={props.call}
        collection={view.collection}
        row={open.row}
        action={open.action}
        onClose={() => setOpen(null)}
        onDone={() => { void refresh(); }}
      />
    );
  }
  if (view.rows.length === 0) return <p className="text-muted-foreground p-4 text-sm">Nothing to show.</p>;
  const columns = [...new Set(view.rows.flatMap((row) => Object.keys(row)))].filter((field) => field !== "version").slice(0, 4);
  return (
    <ul data-slot="app-rows" className="grid gap-2 p-3">
      {view.rows.map((row, index) => (
        <li key={typeof row["id"] === "string" ? row["id"] : index} className="grid gap-2 rounded-md border p-3 text-sm">
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
              {view.rowActions.map((action) => (
                <button
                  key={action.capability}
                  type="button"
                  className="rounded-md border px-3 py-1 font-medium"
                  onClick={() => setOpen({ row, action })}
                >
                  {action.title ?? action.capability}
                </button>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RowAction(props: {
  readonly call: CallTool;
  readonly collection: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly action: AppRowAction;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const { call, collection, row, action } = props;
  const controller = useMemo(() => createInteractionController({
    interaction: action,
    row,
    ...(action.version ? { read: (signal: AbortSignal) => readEntry(call, collection, String(row["id"]), signal) } : {}),
    invoke: (values, signal) => invokeTool(call, action.capability, values, signal),
    // One key per opened action, so a retry after an uncertain write reuses it.
    initialInput: Object.fromEntries(idempotencyInputs(action).map((field) => [field, crypto.randomUUID()])),
  }), [call, collection, row, action]);
  const state = useInteraction(controller);
  useEffect(() => { void controller.open(); }, [controller]);
  useEffect(() => { if (state.phase === "succeeded") props.onDone(); }, [state.phase]);
  return (
    <div className="p-3">
      <OperationPanel
        controller={controller}
        title={action.title ?? action.capability}
        description={action.description}
        labels={defaultInteractionLabels}
        onClose={props.onClose}
      >
        <SchemaForm schema={action.inputSchema} controller={controller} state={state} hidden={hiddenInputs(action)} />
      </OperationPanel>
    </div>
  );
}

function format(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
