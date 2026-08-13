import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { fieldLabel } from "../../lib/field-label";
import { api } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { EntryEditorPayload, StaffOperation } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, OperationErrorBox } from "../../ui/page";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { SchemaFields } from "./entry-edit-view";

/** Minimal row identity needed to prefill a bound operation. */
type OperableRow = {
  id: string;
  collection: string;
};

/** Operations bound to rows from this collection. */
export function boundOperationsFor(
  operations: readonly StaffOperation[] | undefined,
  collectionName: string,
): StaffOperation[] {
  return (operations ?? []).filter((op) => op.rowBindings.some((b) => b.collection === collectionName));
}

/** Row operation menu shared by lists and entry pages. */
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

/**
 * Locks the bound reference to this row and renders the remaining
 * operation input as an editable form. The server resolves `rowField`.
 */
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

  // Preserve description-as-label for older manifests without titles.
  const inputFieldSchema = inputField ? operation.input.properties?.[inputField] : undefined;
  const boundFieldLabel = inputField
    ? resolveLocalizedText(inputFieldSchema?.title, language, canonical) ??
      resolveLocalizedText(inputFieldSchema?.description, language, canonical) ??
      fieldLabel(inputField)
    : null;

  const invoke = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ ok: true; output: unknown }>(`/operations/${encodeURIComponent(operation.name)}`, body),
    onSuccess: () => {
      toast.success(t(language, "ops.success", { name: title }));
      onSuccess();
    },
  });

  const canSubmit = !inputField || prefillValue !== undefined;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent closeLabel={t(language, "common.close")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {entryQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-5">
            {inputField ? (
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">{boundFieldLabel}</label>
                <p className="min-h-8 rounded-md border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
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
