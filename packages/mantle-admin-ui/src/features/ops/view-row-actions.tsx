import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import {
  createInteractionController,
  OperationPanel,
  useInteraction,
  type EntrySnapshot,
  type InteractionController,
  type InteractionLabels,
  type InvokeOutcome,
} from "@aotter/mantle-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AdminLanguage } from "../../app/preferences";
import { t, type I18nKey } from "../../app/i18n";
import { callStaffTool } from "../../lib/admin-tools";
import { ApiError } from "../../lib/api";
import { propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { JsonSchema, StaffOperation, ViewRowActionInfo } from "../../lib/types";
import { SchemaFields } from "../content/entry-edit-view";
import { operationFormSchema } from "../content/row-operations";

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

/** The row actions a person may run: listed for the View and staff-operable for them. */
export function runnableRowActions(
  actions: readonly ViewRowActionInfo[] | undefined,
  operations: readonly StaffOperation[] | undefined,
): { action: ViewRowActionInfo; operation: StaffOperation }[] {
  const byName = new Map((operations ?? []).map((operation) => [operation.name, operation]));
  return (actions ?? []).flatMap((action) => {
    const operation = byName.get(action.procedure);
    return operation ? [{ action, operation }] : [];
  });
}

/**
 * Operations a View row feeds (ADR-0029). The interaction runs through the
 * shared controller over staff MCP: `read_entry` confirms the version the
 * person reviews and the operation's own tool performs it.
 */
export function ViewRowActions({ collection, row, actions, language, canonical, sourceSchema, onDone }: {
  collection: string;
  row: Record<string, unknown>;
  actions: readonly { action: ViewRowActionInfo; operation: StaffOperation }[];
  language: AdminLanguage;
  canonical: string | null;
  sourceSchema?: JsonSchema;
  onDone: () => void;
}): React.ReactElement | null {
  // The dialog keeps the row as it was when opened: a refetch or a re-sort
  // of the list never changes which entry it acts on.
  const [open, setOpen] = React.useState<{ action: ViewRowActionInfo; operation: StaffOperation; row: Record<string, unknown> } | null>(null);
  if (actions.length === 0) return null;
  const titles = actions.map(({ operation }) => resolveLocalizedText(operation.title, language, canonical) || operation.name);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t(language, "interaction.rowActions")}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.map((item, index) => (
            <DropdownMenuItem key={actionKey(item.action)} onSelect={() => setOpen({ ...item, row: { ...row } })}>
              {titles[index]}
              {titles.indexOf(titles[index]!) !== titles.lastIndexOf(titles[index]!)
                ? ` (${item.action.bind.map(({ input }) => input).join(", ")})`
                : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {open ? (
        <RowActionDialog
          key={actionKey(open.action)}
          collection={collection}
          row={open.row}
          action={open.action}
          operation={open.operation}
          language={language}
          canonical={canonical}
          sourceSchema={sourceSchema}
          onClose={() => setOpen(null)}
          onDone={onDone}
        />
      ) : null}
    </>
  );
}

function actionKey(action: ViewRowActionInfo): string {
  return `${action.capability}:${action.bind.map(({ input, field }) => `${input}=${field}`).join(",")}`;
}

function RowActionDialog({ collection, row, action, operation, language, canonical, sourceSchema, onClose, onDone }: {
  collection: string;
  row: Record<string, unknown>;
  action: ViewRowActionInfo;
  operation: StaffOperation;
  language: AdminLanguage;
  canonical: string | null;
  sourceSchema?: JsonSchema;
  onClose: () => void;
  onDone: () => void;
}): React.ReactElement {
  const automatic = React.useMemo(() => idempotencyFields(operation.input), [operation.input]);
  const hidden = [...action.bind.map(({ input }) => input), ...(action.version ? [action.version] : []), ...automatic];
  // Created once per opened dialog; a row the action cannot bind is shown, not thrown.
  const [created] = React.useState(() => {
    try {
      return { controller: createRowActionController(collection, row, action, operation.input) };
    } catch (error) {
      return { error };
    }
  });
  const title = resolveLocalizedText(operation.title, language, canonical) || operation.name;
  const description = resolveLocalizedText(operation.description, language, canonical) || undefined;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        closeLabel={t(language, "interaction.close")}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {description ? <DialogDescription className="sr-only">{description}</DialogDescription> : null}
        {"controller" in created && created.controller ? (
          <RowActionPanel
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
            onDone={onDone}
          />
        ) : (
          <p role="alert" className="text-destructive text-sm">{String((created as { error: unknown }).error)}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RowActionPanel({ controller, operation, hidden, automatic, title, description, language, canonical, sourceSchema, onClose, onDone }: {
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
}): React.ReactElement {
  const state = useInteraction(controller);
  const submitted = React.useRef(false);
  const refreshed = React.useRef(false);
  React.useEffect(() => { void controller.open(); }, [controller]);
  React.useEffect(() => {
    if (state.phase === "submitting") submitted.current = true;
    // The list is refreshed once, when the write is known to have landed.
    if (state.phase === "succeeded" && !refreshed.current) {
      refreshed.current = true;
      onDone();
    }
    // A refused or conflicting payload gets a fresh idempotency key: the
    // next submit is a different operation, not a retry of this one.
    if (state.phase === "failed" || state.phase === "conflict") {
      for (const field of automatic) controller.edit(field, crypto.randomUUID());
    }
  }, [state.phase]);
  const close = () => {
    if (state.phase !== "succeeded" && state.phase !== "cancelled") controller.cancel();
    // A write that may have landed still refreshes the list.
    if (submitted.current && !refreshed.current) {
      refreshed.current = true;
      onDone();
    }
    onClose();
  };
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

export function createRowActionController(
  collection: string,
  row: Record<string, unknown>,
  action: ViewRowActionInfo,
  input: JsonSchema,
): InteractionController {
  return createInteractionController({
    interaction: action,
    row,
    ...(action.version ? { read: (signal: AbortSignal) => readEntry(collection, String(row["id"]), signal) } : {}),
    invoke: (values, signal) => invokeStaffTool(action.capability, values, signal),
    // Idempotency keys are minted once per dialog, so a retry after an
    // uncertain write reuses the same key.
    initialInput: Object.fromEntries(idempotencyFields(input).map((field) => [field, crypto.randomUUID()])),
    automatic: idempotencyFields(input),
  });
}

async function readEntry(collection: string, id: string, signal: AbortSignal): Promise<EntrySnapshot> {
  const { output } = await callStaffTool("read_entry", { collection, id }, signal);
  const entry = output as { id?: unknown; version?: unknown; data?: unknown };
  if (typeof entry.id !== "string" || typeof entry.version !== "number") throw new Error("read_entry returned no entry version.");
  return { id: entry.id, version: entry.version, data: (entry.data as Record<string, unknown> | undefined) ?? {} };
}

/** Business refusals carry the runtime diagnostic; a transport failure is
 *  thrown on so the controller marks the write uncertain. */
async function invokeStaffTool(name: string, values: Record<string, unknown>, signal: AbortSignal): Promise<InvokeOutcome> {
  try {
    const { output } = await callStaffTool(name, values, signal);
    return { ok: true, data: output };
  } catch (error) {
    const body = error instanceof ApiError ? error.body as { code?: unknown; message?: unknown } | null : null;
    if (!body || body.code === "MCP_REQUEST_FAILED" || typeof body.code !== "string") throw error;
    return { ok: false, diagnostics: [{ ...body, code: body.code, message: typeof body.message === "string" ? body.message : body.code }] };
  }
}

/** SchemaFields hands back a cloned value object; only fields that really
 *  changed are edits, so untouched fields keep following a newer review. */
function applyEdits(controller: InteractionController, before: Readonly<Record<string, unknown>>, next: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(next)) {
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) controller.edit(field, value);
  }
}

function idempotencyFields(schema: JsonSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, property]) => property["x-mcp-hint"] === "idempotency-key")
    .map(([name]) => name);
}
