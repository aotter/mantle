import { useEffect, useRef, useState, type ReactNode } from "react";
import { createInteractionController, type InteractionController } from "../controller/index.js";
import { OperationPanel } from "../react/components.js";
import { SchemaFields } from "../react/fields.js";
import { useInteraction } from "../react/use-interaction.js";
import { propertyLabel, renderDataValue, resolveLocalizedText, withNativeSchema, type FieldSchema } from "../react/values.js";
import {
  actionsFor,
  diagnosticsOf,
  hiddenInputs,
  idempotencyInputs,
  invokeTool,
  rowsOf,
  toolOf,
  type AppCatalog,
  type AppCatalogView,
  BARE_VIEW,
  type AppRowAction,
  type CallTool,
  type ToolResult,
} from "../app/bridge.js";
import { appLabels, type AppLabels } from "./locale.js";

type Row = Readonly<Record<string, unknown>>;

const NATIVE_LABEL: Readonly<Record<string, "created" | "updated">> = { created_at: "created", createdAt: "created", updated_at: "updated", updatedAt: "updated" };

/** A field's title in the host's language; the entry's own timestamps in the App's; else the name humanized, as Admin. */
function labelOf(name: string, schema: FieldSchema | undefined, language: string, labels: AppLabels): string {
  if (resolveLocalizedText(schema?.title, language) == null && Object.prototype.hasOwnProperty.call(NATIVE_LABEL, name)) return labels[NATIVE_LABEL[name]!];
  return propertyLabel(name, schema, language);
}

/**
 * The Mantle MCP App: a View tool's rows as Admin shows them, and one row action at a time through the shared controller.
 * What a View's columns are and which tools act on a row come from the catalog the server embedded; every read and write is a
 * server tool call through the host (`callServerTool`), under the caller's own MCP authorization. The App holds no
 * credentials, and opening it has no side effect.
 */
export function MantleApp(props: {
  readonly catalog: AppCatalog;
  readonly call: CallTool;
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
}): ReactNode {
  const labels = appLabels(props.locale);
  const language = props.locale ?? "en";
  const tool = props.result ? toolOf(props.result, props.hostTool) : null;
  // a View the catalog does not describe still shows its rows, with nothing to open
  const view = tool && Object.prototype.hasOwnProperty.call(props.catalog.views, tool) ? props.catalog.views[tool]! : BARE_VIEW;
  const [rows, setRows] = useState<Row[] | null>(() => (props.result ? rowsOf(props.result) : null));
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<{ row: Row; action: AppRowAction } | null>(null);
  useEffect(() => {
    setRows(props.result ? rowsOf(props.result) : null);
    setStale(false);
  }, [props.result]);

  const refresh = async () => {
    if (!tool) return;
    try {
      const fresh = rowsOf(await props.call(tool, { ...props.input }));
      if (fresh) setRows(fresh);
      setStale(!fresh);
    } catch {
      setStale(true);
    }
  };

  if (!props.result) return <p className="text-muted-foreground p-4 text-sm">{props.cancelled ? labels.viewCancelled : labels.waiting}</p>;
  if (!rows) {
    const failure = diagnosticsOf(props.result)[0]?.message;
    return (
      <div role="alert" className="grid gap-1 p-4 text-sm">
        <p className="text-destructive font-medium">{labels.viewFailed}</p>
        {failure ? <p className="text-muted-foreground">{failure}</p> : null}
      </div>
    );
  }
  if (open && tool) {
    return (
      <RowAction
        key={`${open.action.capability}:${String(open.row["id"])}`}
        call={props.call}
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
  if (rows.length === 0) return <>{notice}<p className="text-muted-foreground p-4 text-sm">{labels.nothing}</p></>;
  const columns = columnsOf(view, rows);
  return (
    <>
      {notice}
      <ul data-slot="app-rows" className="grid gap-2 p-3">
        {rows.map((row, index) => {
          const id = typeof row["id"] === "string" ? row["id"] : undefined;
          const actions = actionsFor(props.catalog, view, row);
          return (
            <li key={id ?? index} className="grid gap-2 rounded-md border p-3 text-sm">
              <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
                {columns.map((field) => (
                  <div key={field} className="contents">
                    <dt className="text-muted-foreground">{labelOf(field, view.columns[field], language, labels)}</dt>
                    <dd className="break-words">{renderDataValue(withNativeSchema(field, view.columns[field]), row[field], language)}</dd>
                  </div>
                ))}
              </dl>
              {actions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {actions.map((action) => {
                    const title = resolveLocalizedText(action.title, language) ?? action.capability;
                    return (
                      <button
                        key={action.capability}
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

/** The View's declared list columns, else what the rows carry but the id and version, as Admin's report shows them. */
function columnsOf(view: AppCatalogView, rows: readonly Row[]): string[] {
  if (view.list.columns.length) return [...view.list.columns];
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => field !== "id" && field !== "version").slice(0, 6);
}

function RowAction(props: {
  readonly call: CallTool;
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
  const language = props.locale ?? "en";
  const properties = (action.inputSchema.properties ?? {}) as Readonly<Record<string, FieldSchema>>;
  const fieldLabel = (field: string) => labelOf(field, properties[field], language, props.labels);
  const fieldValue = (field: string, value: unknown) => renderDataValue(withNativeSchema(field, properties[field]), value, language);
  return (
    <div className="p-3">
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
        <SchemaFields
          schema={action.inputSchema as FieldSchema}
          uiSchema={action.uiSchema ?? null}
          value={state.draft}
          onChange={(next) => applyEdits(controller, state.draft, next)}
          language={language}
          hiddenRootFields={hiddenInputs(action)}
          labels={props.labels.fields}
          propertyLabel={(name, schema) => labelOf(name, schema, language, props.labels)}
        />
      </OperationPanel>
    </div>
  );
}

/** SchemaFields hands back a cloned value; only fields that really changed are edits, so untouched fields keep following a newer review. */
function applyEdits(controller: InteractionController, before: Readonly<Record<string, unknown>>, next: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(next)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) controller.edit(field, value);
  }
}
