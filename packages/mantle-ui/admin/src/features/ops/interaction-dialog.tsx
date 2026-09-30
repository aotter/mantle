import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  OperationPanel,
  useInteraction,
  type InteractionController,
  type InteractionLabels,
} from "@aotter/mantle-ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@aotter/mantle-ui/kit";
import type { AdminLanguage } from "../../app/preferences";
import { t, type I18nKey } from "../../app/i18n";
import { propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { JsonSchema, StaffOperation } from "../../lib/types";
import { SchemaFields } from "../content/entry-edit-view";

const LABEL_KEYS: Record<keyof InteractionLabels, I18nKey> = {
  submit: "interaction.submit",
  submitting: "interaction.submitting",
  cancel: "interaction.cancel",
  close: "interaction.close",
  boundInputs: "interaction.boundInputs",
  reviewedEntry: "interaction.reviewedEntry",
  version: "interaction.version",
  changes: "interaction.changes",
  latestChanges: "interaction.latestChanges",
  field: "interaction.field",
  before: "interaction.before",
  after: "interaction.after",
  empty: "interaction.empty",
  loading: "interaction.loading",
  reading: "interaction.reading",
  unreadable: "interaction.unreadable",
  changedSinceList: "interaction.changedSinceList",
  reviewLatest: "interaction.reviewLatest",
  contested: "interaction.contested",
  conflict: "interaction.conflict",
  conflictReopen: "interaction.conflictReopen",
  uncertain: "interaction.uncertain",
  reread: "interaction.reread",
  acknowledgeUncertain: "interaction.acknowledgeUncertain",
  failed: "interaction.failed",
  succeeded: "interaction.succeeded",
  cancelled: "interaction.cancelled",
};

export function interactionLabels(language: AdminLanguage): InteractionLabels {
  return Object.fromEntries(Object.entries(LABEL_KEYS).map(([key, i18n]) => [key, t(language, i18n)])) as unknown as InteractionLabels;
}

/** Inputs Admin fills itself: an idempotency key, minted once per dialog. */
export function idempotencyFields(schema: JsonSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, property]) => property["x-mcp-hint"] === "idempotency-key")
    .map(([name]) => name);
}

/** The operation's input without the fields Admin binds or fills itself. */
export function operationFormSchema(schema: JsonSchema, hiddenFields: readonly string[]): JsonSchema {
  const hidden = new Set(hiddenFields);
  const properties = { ...(schema.properties ?? {}) };
  for (const name of hidden) delete properties[name];
  return {
    ...schema,
    properties,
    required: (schema.required ?? []).filter((name) => !hidden.has(name)),
  };
}

/**
 * One staff operation in a dialog, through the shared interaction
 * controller (ADR-0029). Every Admin entry point uses it, so review,
 * conflicts and uncertain writes behave the same everywhere. The caller
 * decides how the controller reads and invokes.
 */
export function InteractionDialog({ create, operation, hidden, automatic, language, canonical, sourceSchema, onClose, onDone, onSucceeded, renderResult }: {
  /** Called once when the dialog opens; a binding that cannot be met is shown, not thrown. */
  create: () => InteractionController;
  operation: StaffOperation;
  /** Inputs the form does not render: row bindings, the version, idempotency keys. */
  hidden: readonly string[];
  /** Idempotency keys, renewed when a payload is refused or conflicts. */
  automatic: readonly string[];
  language: AdminLanguage;
  canonical: string | null;
  sourceSchema?: JsonSchema;
  onClose: () => void;
  /** Called once when a write landed or may have landed. */
  onDone: () => void;
  /** Called once when the write is known to have landed. */
  onSucceeded?: () => void;
  renderResult?: (result: unknown) => React.ReactNode;
}): React.ReactElement {
  const [created] = React.useState((): { controller: InteractionController } | { error: unknown } => {
    try {
      return { controller: create() };
    } catch (error) {
      return { error };
    }
  });
  const queryClient = useQueryClient();
  // Escape, the close button and the overlay go through the panel's own
  // close, which refuses while a write is in flight.
  const closeRef = React.useRef(onClose);
  const refreshed = () => {
    // An operation can write any collection: every list, count and open
    // entry refetches, as after any other Admin mutation.
    for (const queryKey of [["entry-editor"], ["entries"], ["collection-statistics"]]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    onDone();
  };
  const title = resolveLocalizedText(operation.title, language, canonical) || operation.name;
  const description = resolveLocalizedText(operation.description, language, canonical) || undefined;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) closeRef.current(); }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        closeLabel={t(language, "interaction.close")}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {description ? <DialogDescription className="sr-only">{description}</DialogDescription> : null}
        {"controller" in created ? (
          <InteractionDialogPanel
            controller={created.controller}
            operation={operation}
            hidden={hidden}
            automatic={automatic}
            title={title}
            description={description}
            language={language}
            canonical={canonical}
            sourceSchema={sourceSchema}
            onClose={onClose}
            onDone={refreshed}
            onSucceeded={onSucceeded}
            renderResult={renderResult}
            closeRef={closeRef}
          />
        ) : (
          <p role="alert" className="text-destructive text-sm">{String(created.error)}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InteractionDialogPanel({ controller, operation, hidden, automatic, title, description, language, canonical, sourceSchema, onClose, onDone, onSucceeded, renderResult, closeRef }: {
  controller: InteractionController;
  operation: StaffOperation;
  hidden: readonly string[];
  automatic: readonly string[];
  title: string;
  description: string | undefined;
  language: AdminLanguage;
  canonical: string | null;
  sourceSchema?: JsonSchema;
  onClose: () => void;
  onDone: () => void;
  onSucceeded?: () => void;
  renderResult?: (result: unknown) => React.ReactNode;
  closeRef: React.MutableRefObject<() => void>;
}): React.ReactElement {
  const state = useInteraction(controller);
  const submitted = React.useRef(false);
  const refreshed = React.useRef(false);
  React.useEffect(() => { void controller.open(); }, [controller]);
  React.useEffect(() => {
    if (state.phase === "submitting") submitted.current = true;
    // The page is refreshed once, when the write is known to have landed.
    if (state.phase === "succeeded" && !refreshed.current) {
      refreshed.current = true;
      onSucceeded?.();
      onDone();
    }
    // A refused or conflicting payload gets a fresh idempotency key: the
    // next submit is a different operation, not a retry of this one.
    if (state.phase === "failed" || state.phase === "conflict") {
      for (const field of automatic) controller.edit(field, crypto.randomUUID());
    }
  }, [state.phase]);
  const close = () => {
    // A write in flight cannot be taken back; the dialog stays until it answers.
    if (state.phase === "submitting") return;
    if (state.phase !== "succeeded" && state.phase !== "cancelled") controller.cancel();
    // A write that may have landed still refreshes the page; a refusal did not write.
    if (submitted.current && !refreshed.current && state.phase === "uncertain") {
      refreshed.current = true;
      onDone();
    }
    onClose();
  };
  closeRef.current = close;
  const schema = operationFormSchema(operation.input, hidden);
  const fieldLabel = (field: string) =>
    propertyLabel(field, operation.input.properties?.[field] ?? sourceSchema?.properties?.[field], language, canonical);
  return (
    <OperationPanel
      controller={controller}
      title={title}
      description={description}
      labels={interactionLabels(language)}
      fieldLabel={fieldLabel}
      onClose={close}
      onCancel={close}
      {...(renderResult ? { renderResult } : {})}
    >
      {Object.keys(schema.properties ?? {}).length > 0 ? (
        <SchemaFields
          schema={schema}
          uiSchema={operation.uiSchema}
          value={state.draft}
          path={[]}
          onChange={(next) => applyEdits(controller, state.draft, next)}
          language={language}
          canonical={canonical}
          collectionName={operation.name}
          mediaPurposes={[]}
        />
      ) : null}
    </OperationPanel>
  );
}

/** SchemaFields hands back a cloned value object; only fields that really
 *  changed are edits, so untouched fields keep following a newer review. */
function applyEdits(controller: InteractionController, before: Readonly<Record<string, unknown>>, next: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(next)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) controller.edit(field, value);
  }
}
