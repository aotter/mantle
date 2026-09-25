import type { ReactNode } from "react";
import type {
  EntrySnapshot,
  FieldChange,
  InteractionController,
  InteractionState,
} from "../controller/index.js";
import { defaultInteractionLabels, type InteractionLabels } from "./labels.js";
import { useInteraction } from "./use-interaction.js";

/**
 * Presentational pieces for one interaction. Each reads only the controller
 * snapshot and calls only controller actions, so Admin pages, dialogs, chat
 * surfaces and MCP Apps compose the same parts. Colours come from the host's
 * CSS variables through Tailwind token classes (`bg-muted`, `border`,
 * `text-destructive`, …).
 */

export interface FieldLabelProps {
  /** Human label for a field name; defaults to the name itself. */
  readonly fieldLabel?: (field: string) => string;
}

export function EntityPreview(props: FieldLabelProps & {
  readonly entry: EntrySnapshot;
  /** Fields to show, in order. Defaults to every data field. */
  readonly fields?: readonly string[];
  readonly labels?: Pick<InteractionLabels, "reviewedEntry" | "version" | "empty">;
}): ReactNode {
  const labels = props.labels ?? defaultInteractionLabels;
  const label = props.fieldLabel ?? ((field: string) => field);
  const fields = props.fields ?? Object.keys(props.entry.data).filter((field) => field !== "version");
  return (
    <section data-slot="entity-preview" aria-label={labels.reviewedEntry} className="rounded-md border p-3 text-sm">
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1">
        {fields.map((field) => (
          <div key={field} className="contents">
            <dt className="text-muted-foreground">{label(field)}</dt>
            <dd className="min-w-0 break-words">{formatValue(props.entry.data[field], labels.empty)}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">{labels.version}</dt>
        <dd>{props.entry.version}</dd>
      </dl>
    </section>
  );
}

export function ChangeDiff(props: FieldLabelProps & {
  readonly changes: readonly FieldChange[];
  readonly caption?: string;
  readonly labels?: Pick<InteractionLabels, "changes" | "field" | "before" | "after" | "empty">;
}): ReactNode {
  const labels = props.labels ?? defaultInteractionLabels;
  const label = props.fieldLabel ?? ((field: string) => field);
  if (props.changes.length === 0) return null;
  return (
    <table data-slot="change-diff" className="w-full text-sm">
      <caption className="text-muted-foreground mb-1 text-left">{props.caption ?? labels.changes}</caption>
      <thead>
        <tr className="text-muted-foreground text-left">
          <th scope="col" className="font-medium">{labels.field}</th>
          <th scope="col" className="font-medium">{labels.before}</th>
          <th scope="col" className="font-medium">{labels.after}</th>
        </tr>
      </thead>
      <tbody>
        {props.changes.map((change) => (
          <tr key={change.field} className="border-t align-top">
            <th scope="row" className="py-1 pr-2 text-left font-normal">{label(change.field)}</th>
            <td className="py-1 pr-2 line-through decoration-muted-foreground/60">{formatValue(change.before, labels.empty)}</td>
            <td className="py-1">{formatValue(change.after, labels.empty)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What the person has to know or do next, per phase, with its one action. */
export function OperationStatus(props: FieldLabelProps & {
  readonly controller: InteractionController;
  readonly state: InteractionState;
  readonly labels?: InteractionLabels;
}): ReactNode {
  const { controller, state } = props;
  const labels = props.labels ?? defaultInteractionLabels;
  const label = props.fieldLabel ?? ((field: string) => field);
  const notice = (tone: "info" | "warning" | "error", message: string, action?: ReactNode, extra?: ReactNode) => (
    <div
      data-slot="operation-status"
      data-phase={state.phase}
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border p-3 text-sm ${tone === "error" ? "border-destructive/50 text-destructive" : tone === "warning" ? "bg-muted" : ""}`}
    >
      <p>{message}</p>
      {extra}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
  const button = (text: string, onClick: () => void) => (
    <button type="button" onClick={onClick} disabled={state.reading} className="rounded-md border px-3 py-1 text-sm font-medium">
      {text}
    </button>
  );
  const diagnostics = state.diagnostics.length > 0
    ? <ul className="mt-1 list-disc pl-5">{state.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic.message}</li>)}</ul>
    : null;
  switch (state.phase) {
    case "loading":
      return notice("info", labels.loading);
    case "unreadable":
      return notice("error", labels.unreadable, button(labels.reread, () => void controller.reread()));
    case "changedSinceList":
      return notice("warning", labels.changedSinceList, button(labels.reviewLatest, () => controller.review()), (
        <>
          {state.contested.length > 0
            ? <p className="mt-1 font-medium">{labels.contested} {state.contested.map(label).join(", ")}</p>
            : null}
          <ChangeDiff changes={controller.latestChanges()} caption={labels.latestChanges} labels={labels} fieldLabel={props.fieldLabel} />
        </>
      ));
    case "conflict":
      return notice("error", labels.conflict, button(labels.reread, () => void controller.reread()));
    case "uncertain":
      return notice("error", labels.uncertain, !state.canRead
        ? button(labels.acknowledgeUncertain, () => controller.acknowledgeUncertain())
        : button(labels.reread, () => void controller.reread()), diagnostics);
    case "failed":
      return notice("error", labels.failed, undefined, diagnostics);
    case "cancelled":
      return notice("info", labels.cancelled);
    default:
      return state.reading ? notice("info", labels.reading) : null;
  }
}

export function OperationOutcome(props: {
  readonly state: InteractionState;
  readonly labels?: Pick<InteractionLabels, "succeeded">;
  /** Render the result; defaults to nothing beyond the success message. */
  readonly renderResult?: (result: unknown) => ReactNode;
}): ReactNode {
  if (props.state.phase !== "succeeded") return null;
  const labels = props.labels ?? defaultInteractionLabels;
  return (
    <div data-slot="operation-outcome" role="status" className="rounded-md border p-3 text-sm">
      <p className="font-medium">{labels.succeeded}</p>
      {props.renderResult?.(props.state.result)}
    </div>
  );
}

/**
 * One interaction, ready to place in a page, dialog or chat surface. The
 * host renders the editable inputs as `children` and wires them to
 * `controller.edit`; everything else comes from the controller.
 */
export function OperationPanel(props: FieldLabelProps & {
  readonly controller: InteractionController;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly labels?: InteractionLabels;
  /** Fields of the reviewed entry to preview; omit to hide the preview. */
  readonly previewFields?: readonly string[];
  readonly renderResult?: (result: unknown) => ReactNode;
  /** Called when the person closes the panel after it finished or was cancelled. */
  readonly onClose?: () => void;
}): ReactNode {
  const { controller } = props;
  const state = useInteraction(controller);
  const labels = props.labels ?? defaultInteractionLabels;
  const label = props.fieldLabel ?? ((field: string) => field);
  const busy = state.phase === "submitting" || state.phase === "loading";
  const done = state.phase === "succeeded" || state.phase === "cancelled";
  const canSubmit = (state.phase === "ready" || state.phase === "failed") && !state.reading;
  const bound = Object.entries(state.bound);
  return (
    <form
      data-slot="operation-panel"
      aria-busy={busy || state.reading}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.submit();
      }}
    >
      <header className="grid gap-1">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.description ? <p className="text-muted-foreground text-sm">{props.description}</p> : null}
      </header>
      {bound.length > 0 ? (
        <section aria-label={labels.boundInputs} className="bg-muted rounded-md p-3 text-sm">
          <p className="text-muted-foreground mb-1">{labels.boundInputs}</p>
          <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3">
            {bound.map(([field, value]) => (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{label(field)}</dt>
                <dd className="break-words">{formatValue(value, labels.empty)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {props.previewFields && state.reviewed
        ? <EntityPreview entry={state.reviewed} fields={props.previewFields} labels={labels} fieldLabel={props.fieldLabel} />
        : null}
      <fieldset disabled={busy || done} className="grid gap-3">{props.children}</fieldset>
      <ChangeDiff changes={controller.changes()} labels={labels} fieldLabel={props.fieldLabel} />
      <OperationStatus controller={controller} state={state} labels={labels} fieldLabel={props.fieldLabel} />
      <OperationOutcome state={state} labels={labels} renderResult={props.renderResult} />
      <footer className="flex justify-end gap-2">
        {done ? (
          <button type="button" onClick={props.onClose} className="rounded-md border px-3 py-2 text-sm font-medium">{labels.close}</button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => { controller.cancel(); }}
              className="rounded-md border px-3 py-2 text-sm font-medium"
            >
              {labels.cancel}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {state.phase === "submitting" ? labels.submitting : labels.submit}
            </button>
          </>
        )}
      </footer>
    </form>
  );
}

function formatValue(value: unknown, empty: string): string {
  if (value === undefined || value === null || value === "") return empty;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
