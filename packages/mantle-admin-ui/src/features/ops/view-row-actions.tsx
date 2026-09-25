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

const LABEL_KEYS = [
  "submit", "submitting", "cancel", "close", "boundInputs", "reviewedEntry", "version", "changes", "latestChanges", "field",
  "before", "after", "empty", "loading", "reading", "unreadable", "changedSinceList", "reviewLatest",
  "contested", "conflict", "uncertain", "reread", "acknowledgeUncertain", "failed", "succeeded", "cancelled",
] as const satisfies readonly (keyof InteractionLabels)[];

export function interactionLabels(language: AdminLanguage): InteractionLabels {
  return Object.fromEntries(LABEL_KEYS.map((key) => [key, t(language, `interaction.${key}` as I18nKey)])) as unknown as InteractionLabels;
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
  const [open, setOpen] = React.useState<{ action: ViewRowActionInfo; operation: StaffOperation } | null>(null);
  if (actions.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t(language, "interaction.rowActions")}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.map((item) => (
            <DropdownMenuItem key={item.action.capability} onSelect={() => setOpen(item)}>
              {resolveLocalizedText(item.operation.title, language, canonical) || item.operation.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {open ? (
        <RowActionDialog
          key={open.action.capability}
          collection={collection}
          row={row}
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
  const hidden = React.useMemo(() => [
    ...action.bind.map(({ input }) => input),
    ...(action.version ? [action.version] : []),
    ...idempotencyFields(operation.input),
  ], [action, operation.input]);
  const controller = React.useMemo(() => createRowActionController(collection, row, action, operation.input), [collection, row, action, operation.input]);
  const state = useInteraction(controller);
  React.useEffect(() => { void controller.open(); }, [controller]);
  React.useEffect(() => {
    if (state.phase === "succeeded") onDone();
  }, [state.phase, onDone]);
  const schema = operationFormSchema(operation.input, hidden);
  const fieldLabel = (field: string) =>
    propertyLabel(field, operation.input.properties?.[field] ?? sourceSchema?.properties?.[field], language, canonical);
  const title = resolveLocalizedText(operation.title, language, canonical) || operation.name;
  const description = resolveLocalizedText(operation.description, language, canonical) || undefined;
  const close = () => {
    if (state.phase !== "succeeded" && state.phase !== "cancelled") controller.cancel();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" closeLabel={t(language, "interaction.close")}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
        <OperationPanel
          controller={controller}
          title={title}
          description={description}
          labels={interactionLabels(language)}
          fieldLabel={fieldLabel}
          onClose={close}
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
      </DialogContent>
    </Dialog>
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

function applyEdits(controller: InteractionController, before: Readonly<Record<string, unknown>>, next: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(next)) {
    if (before[field] !== value) controller.edit(field, value);
  }
}

function idempotencyFields(schema: JsonSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, property]) => property["x-mcp-hint"] === "idempotency-key")
    .map(([name]) => name);
}
