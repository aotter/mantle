import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, PencilLine, Plus, Workflow } from "lucide-react";
import {
  createInteractionController,
  type EntrySnapshot,
  type InteractionController,
  type InvokeOutcome,
} from "@aotter/mantle-ui";
import { fieldLabel } from "../../lib/field-label";
import { api, ApiError } from "../../lib/api";
import { resolveLocalizedText } from "../../lib/localized-text";
import { entryApiPath } from "../../lib/queries";
import type { EntryEditorPayload, StaffOperation, StaffOperationInteraction } from "../../lib/types";
import { Button } from "@aotter/mantle-ui/kit";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { ErrorBox, redirectToSignIn } from "../../ui/page";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@aotter/mantle-ui/kit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@aotter/mantle-ui/kit";
import type { AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { idempotencyFields, InteractionDialog } from "../ops/interaction-dialog";

export { operationFormSchema } from "../ops/interaction-dialog";

/**
 * The row an operation opens from, as the page listed it. `version` and
 * `data` are what the page showed; bound fields missing from them are read
 * before the dialog opens.
 */
export type OperableRow = {
  id: string;
  collection: string;
  version?: number;
  data?: Record<string, unknown>;
  data_preview?: Record<string, unknown>;
};

/** Operations bound to rows from this collection. */
export function boundOperationsFor(
  operations: readonly StaffOperation[] | undefined,
  collectionName: string,
): StaffOperation[] {
  return (operations ?? []).filter((op) => (op.interactions ?? []).some((item) => item.collection === collectionName));
}

/** Operations explicitly exposed from a collection header. */
export function collectionOperationsFor(
  operations: readonly StaffOperation[] | undefined,
  collectionName: string,
): StaffOperation[] {
  return (operations ?? []).filter((op) => op.uiSchema?.["collectionAction"] === collectionName);
}

/** The values a row feeds the controller: its id, version and fields. */
export function rowValues(row: OperableRow): Record<string, unknown> {
  return {
    ...(row.data_preview ?? {}),
    ...(row.data ?? {}),
    id: row.id,
    ...(typeof row.version === "number" ? { version: row.version } : {}),
  };
}

/** Row operation menu shared by lists and entry pages. */
export function RowOperationsMenu({
  row,
  operations,
  editHref,
  language,
  canonical,
  onSuccess,
  trigger,
}: {
  row: OperableRow;
  /** Pre-filtered via `boundOperationsFor(allOps, row.collection)`. */
  operations: readonly StaffOperation[];
  editHref?: string;
  language: AdminLanguage;
  canonical: string | null;
  onSuccess: () => void;
  /** Custom trigger element (e.g. a full `Button` in a page header).
   *  Defaults to the compact "⋯" icon button used in table rows. */
  trigger?: React.ReactNode;
}): React.ReactElement | null {
  const [activeOperation, setActiveOperation] = React.useState<StaffOperation | null>(null);
  if (operations.length === 0 && !editHref) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={t(language, "rowActions.menuLabel")}
              aria-label={t(language, "rowActions.menuLabel")}
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editHref ? (
            <DropdownMenuItem asChild>
              <a href={editHref}>
                <PencilLine aria-hidden />
                {t(language, "entryWorkbench.editEntry")}
              </a>
            </DropdownMenuItem>
          ) : null}
          {operations.map((op) => (
            <DropdownMenuItem key={op.name} onSelect={() => setActiveOperation(op)}>
              <Workflow aria-hidden />
              {resolveLocalizedText(op.title, language, canonical) ?? fieldLabel(op.name)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {activeOperation ? (
        <OperationDialog
          key={activeOperation.name}
          operation={activeOperation}
          interaction={(activeOperation.interactions ?? []).find((item) => item.collection === row.collection)}
          row={row}
          language={language}
          canonical={canonical}
          onClose={() => setActiveOperation(null)}
          onSuccess={onSuccess}
        />
      ) : null}
    </>
  );
}

/** Collection-level operation buttons shared by all collection lists. */
export function CollectionOperations({
  operations,
  language,
  canonical,
  onSuccess,
}: {
  operations: readonly StaffOperation[];
  language: AdminLanguage;
  canonical: string | null;
  onSuccess: () => void;
}): React.ReactElement | null {
  const [activeOperation, setActiveOperation] = React.useState<StaffOperation | null>(null);
  if (operations.length === 0) return null;

  return (
    <>
      {operations.map((operation) => (
        <Button key={operation.name} type="button" onClick={() => setActiveOperation(operation)}>
          <Plus className="size-4" aria-hidden />
          {resolveLocalizedText(operation.title, language, canonical) ?? fieldLabel(operation.name)}
        </Button>
      ))}
      {activeOperation ? (
        <OperationDialog
          key={activeOperation.name}
          operation={activeOperation}
          language={language}
          canonical={canonical}
          onClose={() => setActiveOperation(null)}
          onSuccess={onSuccess}
        />
      ) : null}
    </>
  );
}

/**
 * One staff operation through the shared interaction controller
 * (ADR-0029), from a row, a collection header or the Operations page.
 * Bindings and the version lock come only from the operation's declared
 * interaction for the row's collection; nothing is inferred from names.
 * Without one, the operation is an ordinary form.
 */
export function OperationDialog({
  operation,
  interaction,
  row,
  language,
  canonical,
  onClose,
  onSuccess,
}: {
  operation: StaffOperation;
  interaction?: StaffOperationInteraction;
  row?: OperableRow;
  language: AdminLanguage;
  canonical: string | null;
  onClose: () => void;
  onSuccess: () => void;
}): React.ReactElement {
  const title = resolveLocalizedText(operation.title, language, canonical) ?? fieldLabel(operation.name);
  const binding = row && interaction ? interaction : undefined;
  const listed = row ? rowValues(row) : undefined;
  // A bound field the page did not list (for example a unique key) is read
  // once before the dialog opens; that read is the row the person reviews.
  const missing = Boolean(binding && listed && binding.bind.some(({ field }) => !(field in listed)));
  const entry = useQuery<EntryEditorPayload>({
    queryKey: ["entry-editor", row?.collection ?? "", row?.id ?? "", "operation"],
    queryFn: ({ signal }) => api.get<EntryEditorPayload>(entryApiPath(row!.collection, row!.id), { signal }),
    enabled: missing,
    staleTime: 0,
    gcTime: 0,
  });
  const automatic = idempotencyFields(operation.input);
  const hidden = [
    ...(binding ? binding.bind.map(({ input }) => input) : []),
    ...(binding?.version ? [binding.version] : []),
    ...automatic,
  ];

  if (missing && !entry.data) {
    return (
      <InteractionLoading language={language} onClose={onClose}>
        {entry.isError ? <ErrorBox error={entry.error} /> : <Skeleton className="h-24 w-full" />}
      </InteractionLoading>
    );
  }
  const reviewed = entry.data ? { ...listed, ...entry.data.entry.data, id: entry.data.entry.id, version: entry.data.entry.version } : listed;
  return (
    <InteractionDialog
      create={() => createOperationController(operation, binding, row?.collection, reviewed)}
      operation={operation}
      hidden={hidden}
      automatic={automatic}
      language={language}
      canonical={canonical}
      onClose={onClose}
      onDone={onSuccess}
      onSucceeded={() => toast.success(t(language, "ops.success", { name: title }))}
      renderResult={(output) => (
        <section aria-label={t(language, "ops.output")} className="mt-2 min-w-0 space-y-2">
          <h3 className="text-sm font-semibold">{t(language, "ops.output")}</h3>
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs" tabIndex={0}>
            {JSON.stringify(output ?? null, null, 2)}
          </pre>
        </section>
      )}
    />
  );
}

/**
 * The controller for one Admin operation: it reads the entry through the
 * Admin entry API and runs the operation through the Admin operations API,
 * so HTTP-only staff operations work the same as MCP ones.
 */
export function createOperationController(
  operation: StaffOperation,
  interaction: StaffOperationInteraction | undefined,
  collection: string | undefined,
  row: Record<string, unknown> | undefined,
): InteractionController {
  const automatic = idempotencyFields(operation.input);
  return createInteractionController({
    interaction: interaction ?? { bind: [] },
    ...(interaction && row ? { row } : {}),
    ...(interaction?.version && collection && row
      ? { read: (signal: AbortSignal) => readEntry(collection, String(row["id"]), signal) }
      : {}),
    invoke: (values, signal) => invokeOperation(operation.name, values, signal),
    // Minted once per dialog, so a retry after an uncertain write reuses it.
    initialInput: Object.fromEntries(automatic.map((field) => [field, crypto.randomUUID()])),
    automatic,
  });
}

async function readEntry(collection: string, id: string, signal: AbortSignal): Promise<EntrySnapshot> {
  try {
    const { entry } = await api.get<EntryEditorPayload>(entryApiPath(collection, id), { signal });
    return { id: entry.id, version: entry.version, data: entry.data };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirectToSignIn();
    throw error;
  }
}

/** A refusal carries the runtime diagnostic; anything else is thrown so the
 *  controller treats the write as uncertain and never retries it. */
async function invokeOperation(name: string, values: Record<string, unknown>, signal: AbortSignal): Promise<InvokeOutcome> {
  try {
    const { output } = await api.post<{ ok: true; output: unknown }>(`/operations/${encodeURIComponent(name)}`, values, { signal });
    return { ok: true, data: output };
  } catch (error) {
    // An expired session was never let in, so nothing ran: sign in again.
    if (error instanceof ApiError && error.status === 401) redirectToSignIn();
    const diagnostic = error instanceof ApiError
      ? (error.body as { diagnostic?: { code?: unknown; message?: unknown } } | null)?.diagnostic
      : undefined;
    if (!diagnostic || typeof diagnostic.code !== "string") throw error;
    return {
      ok: false,
      diagnostics: [{ ...diagnostic, code: diagnostic.code, message: typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.code }],
    };
  }
}

function InteractionLoading({ language, onClose, children }: {
  language: AdminLanguage;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent closeLabel={t(language, "interaction.close")} aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t(language, "interaction.loading")}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
