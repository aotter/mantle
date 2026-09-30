import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import {
  createInteractionController,
  type EntrySnapshot,
  type InteractionController,
  type InvokeOutcome,
} from "@aotter/mantle-ui";
import { Button } from "@aotter/mantle-ui/kit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aotter/mantle-ui/kit";
import type { AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { callStaffTool } from "../../lib/admin-tools";
import { ApiError } from "../../lib/api";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { JsonSchema, StaffOperation, ViewRowActionInfo } from "../../lib/types";
import { idempotencyFields, InteractionDialog } from "./interaction-dialog";

export { interactionLabels } from "./interaction-dialog";

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
  const automatic = idempotencyFields(operation.input);
  return (
    <InteractionDialog
      create={() => createRowActionController(collection, row, action, operation.input)}
      operation={operation}
      hidden={[...action.bind.map(({ input }) => input), ...(action.version ? [action.version] : []), ...automatic]}
      automatic={automatic}
      language={language}
      canonical={canonical}
      sourceSchema={sourceSchema}
      onClose={onClose}
      onDone={onDone}
    />
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
