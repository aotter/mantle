import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { fieldLabel } from "../../lib/field-label";
import { api } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { EntryEditorPayload, StaffOperation } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, OperationErrorBox } from "../../ui/page";
import { useToast } from "../../ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import type { AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { SchemaFields } from "./entry-edit-view";

/** Minimal row identity a row-bound operation needs to prefill and
 *  invoke itself: which entry, in which collection. Both `EntryRow`
 *  (`lib/types.ts`, the collection list) and `EntryEditorEntry` (the
 *  entry editor + its related/child sections) satisfy this shape,
 *  which is what lets `RowOperationsMenu`/`RowActionDialog` serve the
 *  list's "⋯" menu (#430), the entry editor's page-header actions, and
 *  the parent editor's child-entry rows (#442) off one implementation. */
type OperableRow = {
  id: string;
  collection: string;
};

/** Staff operations (#430) whose `rowBindings` include `collectionName`
 *  — the same filter `collection-view.tsx` has always applied, now
 *  shared so the entry editor (#442) derives the identical set for its
 *  own collection and for each child-entries section. */
export function boundOperationsFor(
  operations: readonly StaffOperation[] | undefined,
  collectionName: string,
): StaffOperation[] {
  return (operations ?? []).filter((op) => op.rowBindings.some((b) => b.collection === collectionName));
}

/**
 * "⋯" row-operations menu (#430, shared #442): given the staff
 * operations already bound to `row.collection` (via `boundOperationsFor`
 * above), renders a dropdown of their labels and opens `RowActionDialog`
 * for whichever one the user picks. Renders nothing (`null`) when there
 * are no bound operations — callers can render this unconditionally.
 */
export function RowOperationsMenu({
  row,
  operations,
  language,
  canonical,
  onSuccess,
  trigger,
}: {
  row: OperableRow;
  /** Pre-filtered via `boundOperationsFor(allOps, row.collection)`. */
  operations: readonly StaffOperation[];
  language: AdminLanguage;
  canonical: string | null;
  onSuccess: () => void;
  /** Custom trigger element (e.g. a full `Button` in a page header).
   *  Defaults to the compact "⋯" icon button used in table rows. */
  trigger?: React.ReactNode;
}): React.ReactElement | null {
  const [activeOperation, setActiveOperation] = React.useState<StaffOperation | null>(null);
  if (operations.length === 0) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <button
              type="button"
              className="row-action"
              title={t(language, "rowActions.menuLabel")}
              aria-label={t(language, "rowActions.menuLabel")}
            >
              <MoreHorizontal className="size-3.5" aria-hidden />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {operations.map((op) => (
            <DropdownMenuItem key={op.name} onSelect={() => setActiveOperation(op)}>
              {resolveLocalizedText(op.title, language, canonical) ?? fieldLabel(op.name)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {activeOperation ? (
        <RowActionDialog
          operation={activeOperation}
          binding={activeOperation.rowBindings.find((b) => b.collection === row.collection)}
          row={row}
          language={language}
          canonical={canonical}
          onClose={() => setActiveOperation(null)}
          onSuccess={() => {
            setActiveOperation(null);
            onSuccess();
          }}
        />
      ) : null}
    </>
  );
}

/** Row-action modal (#430, shared #442): pre-fills and locks the
 *  operation's bound `x-mantle-ref` input field to this row's identity,
 *  then renders the rest of the operation's `input` schema as an
 *  editable form.
 *
 *  Design decision: `SchemaFields`/`SchemaField` have no generic
 *  "render this one property read-only" prop (only the hardcoded
 *  `x-mantle-bind` check). Rather than thread a new prop through the
 *  whole recursive renderer for a single call site, the bound field is
 *  rendered here as its own read-only block (mirroring the existing
 *  read-only style block in `SchemaField`), and `SchemaFields` renders
 *  a shallow-cloned copy of `operation.input` with that ONE property
 *  omitted from `properties`/`required` — so the field can't be edited
 *  twice or shown twice. The bound value is merged back into the POST
 *  body from component state seeded on fetch, independent of whatever
 *  `SchemaFields`'s onChange produces for the remaining fields.
 *
 *  `binding.rowField` is resolved server-side by the same-name-first
 *  rule in `discoverRowBindings`/`sameNameField` (M5,
 *  `mountServerEndpoints.ts`): a same-named property on the target
 *  collection wins over falling back to a single-field unique index,
 *  which itself wins over the reserved `id` column. This component
 *  only consumes the already-resolved `rowField` — it does not
 *  re-derive or duplicate that rule. */
function RowActionDialog({
  operation,
  binding,
  row,
  language,
  canonical,
  onClose,
  onSuccess,
}: {
  operation: StaffOperation;
  binding: { collection: string; inputField: string; rowField: string } | undefined;
  row: OperableRow;
  language: AdminLanguage;
  canonical: string | null;
  onClose: () => void;
  onSuccess: () => void;
}): React.ReactElement {
  const title = resolveLocalizedText(operation.title, language, canonical) ?? fieldLabel(operation.name);
  const description = resolveLocalizedText(operation.description, language, canonical);
  const rowField = binding?.rowField ?? "id";
  const inputField = binding?.inputField;

  const entryQuery = useQuery<EntryEditorPayload>({
    queryKey: ["entry-editor", row.collection, row.id],
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(row.id)}`),
  });

  const prefillValue = React.useMemo(() => {
    if (rowField === "id") return row.id;
    return entryQuery.data?.entry.data[rowField] ?? undefined;
  }, [entryQuery.data, rowField, row.id]);

  const [formValue, setFormValue] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    if (prefillValue === undefined || !inputField) return;
    setFormValue((prev) => ({ ...prev, [inputField]: prefillValue }));
  }, [prefillValue, inputField]);

  const editableSchema = React.useMemo(() => {
    if (!inputField) return operation.input;
    const properties = { ...(operation.input.properties ?? {}) };
    delete properties[inputField];
    const required = (operation.input.required ?? []).filter((name) => name !== inputField);
    return { ...operation.input, properties, required };
  }, [operation.input, inputField]);

  // Label precedence (#443): the property's `title` keyword first, then
  // the pre-#443 `description`-as-label reuse (kept for manifests
  // written before `title` existed), then the humanized field name.
  const inputFieldSchema = inputField ? operation.input.properties?.[inputField] : undefined;
  const boundFieldLabel = inputField
    ? resolveLocalizedText(inputFieldSchema?.title, language, canonical) ??
      resolveLocalizedText(inputFieldSchema?.description, language, canonical) ??
      fieldLabel(inputField)
    : null;

  const { showToast } = useToast();
  const invoke = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ ok: true; output: unknown }>(`/operations/${encodeURIComponent(operation.name)}`, body),
    onSuccess: () => {
      // #444: the dialog closes right after this and the list refreshes
      // silently — without a toast the operator has no confirmation the
      // operation actually ran, only that the modal is gone.
      showToast(t(language, "ops.success", { name: title }));
      onSuccess();
    },
  });

  const canSubmit = !inputField || prefillValue !== undefined;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {entryQuery.isLoading ? (
          <div className="glass-card h-24 animate-pulse" />
        ) : (
          <div className="space-y-5">
            {inputField ? (
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">{boundFieldLabel}</label>
                <p className="admin-input cursor-not-allowed bg-muted/40 text-muted-foreground">
                  {stringifyBoundValue(prefillValue)}
                </p>
              </div>
            ) : null}
            <SchemaFields
              schema={editableSchema}
              value={formValue}
              path={[]}
              onChange={setFormValue}
              language={language}
              canonical={canonical}
              collectionName={operation.name}
              mediaPurposes={[]}
            />
          </div>
        )}

        {entryQuery.isError ? <ErrorBox error={entryQuery.error} /> : null}
        {invoke.isError ? <OperationErrorBox error={asRenderable(invoke.error)} /> : null}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={invoke.isPending}>
            {t(language, "rowActions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => invoke.mutate(formValue)}
            disabled={invoke.isPending || !canSubmit}
          >
            {invoke.isPending ? t(language, "ops.running") : t(language, "ops.run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function stringifyBoundValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
