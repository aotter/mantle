import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { fieldLabel } from "../../lib/field-label";
import { api, ApiError } from "../../lib/api";
import { asRenderable } from "../../lib/errors";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { EntryEditorPayload, JsonSchema, StaffOperation } from "../../lib/types";
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

/** Reserved OCC wire name. Observed native `entry.version` at read time. */
export const EXPECTED_VERSION_PROPERTY = "expectedVersion";

/** Minimal row identity needed to prefill a bound operation. */
type OperableRow = {
  id: string;
  collection: string;
};

export type OperationRowBinding = {
  collection: string;
  inputField: string;
  rowField: string;
};

/** Operations bound to rows from this collection. */
export function boundOperationsFor(
  operations: readonly StaffOperation[] | undefined,
  collectionName: string,
): StaffOperation[] {
  return (operations ?? []).filter((op) => op.rowBindings.some((b) => b.collection === collectionName));
}

/** Operations explicitly exposed from a collection header. */
export function collectionOperationsFor(
  operations: readonly StaffOperation[] | undefined,
  collectionName: string,
): StaffOperation[] {
  return (operations ?? []).filter((op) => op.uiSchema?.["collectionAction"] === collectionName);
}

export function automaticOperationInputFields(schema: JsonSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([name, property]) =>
      name === EXPECTED_VERSION_PROPERTY || property["x-mcp-hint"] === "idempotency-key",
    )
    .map(([name]) => name);
}

export function operationDeclaresExpectedVersion(schema: JsonSchema): boolean {
  return EXPECTED_VERSION_PROPERTY in (schema.properties ?? {});
}

/**
 * Entry id whose native version is bound as `expectedVersion`.
 * Prefer the mutated row (`id` / builtin target collection), never a
 * leftover parent-row version after the operator changes target.
 */
export function resolveOccTargetId(args: {
  input: JsonSchema;
  formValue: Record<string, unknown>;
  row?: OperableRow;
  binding?: OperationRowBinding;
  rowBindings?: readonly OperationRowBinding[];
  targetCollection?: string | null;
}): string | undefined {
  const properties = args.input.properties ?? {};
  if ("id" in properties) {
    const id = args.formValue.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  const bindings = args.rowBindings ?? (args.binding ? [args.binding] : []);
  const preferred = args.targetCollection
    ? bindings.find((binding) => binding.collection === args.targetCollection)
    : undefined;
  if (preferred) {
    const value = args.formValue[preferred.inputField];
    if (preferred.rowField === "id" && typeof value === "string" && value.length > 0) {
      return value;
    }
    if (args.row?.collection === preferred.collection) return args.row.id;
    return undefined;
  }

  if (args.targetCollection && args.row?.collection !== args.targetCollection) {
    const other = bindings.find(
      (binding) => binding.collection === args.targetCollection && binding.rowField === "id",
    );
    if (other) {
      const value = args.formValue[other.inputField];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }
    return undefined;
  }

  if (args.row) {
    const other = bindings.find(
      (binding) => binding.collection !== args.row!.collection && binding.rowField === "id",
    );
    if (other) {
      const value = args.formValue[other.inputField];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }
  }

  return args.row?.id;
}

/**
 * Whether the operation dialog may submit OCC. A resolvable target or a
 * row-bound dialog is update-path intent and must wait for the observed
 * version. Collection create / no-row dialogs may omit when the field is
 * not required.
 */
export function operationVersionReady(args: {
  readonly declaresExpectedVersion: boolean;
  readonly expectedVersionRequired: boolean;
  readonly capturedVersion: unknown;
  readonly occTargetId: string | undefined;
  readonly boundRow: boolean;
}): boolean {
  if (!args.declaresExpectedVersion) return true;
  if (typeof args.capturedVersion === "number" && Number.isFinite(args.capturedVersion)) return true;
  if (args.occTargetId || args.boundRow) return false;
  return !args.expectedVersionRequired;
}

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
        <OperationDialog
          operation={activeOperation}
          binding={activeOperation.rowBindings.find((b) => b.collection === row.collection)}
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
 * Locks the bound reference to this row and renders the remaining
 * operation input as an editable form. The server resolves `rowField`.
 * `expectedVersion` is bound from the OCC target's observed version and
 * hidden from the form (ADR-0022).
 */
export function OperationDialog({
  operation,
  binding,
  row,
  language,
  canonical,
  onClose,
  onSuccess,
}: {
  operation: StaffOperation;
  binding?: OperationRowBinding;
  row?: OperableRow;
  language: AdminLanguage;
  canonical: string | null;
  onClose: () => void;
  onSuccess: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const title = resolveLocalizedText(operation.title, language, canonical) ?? fieldLabel(operation.name);
  const description = resolveLocalizedText(operation.description, language, canonical);
  const rowField = binding?.rowField ?? "id";
  const inputField = binding?.inputField;
  const hasExpectedVersion = operationDeclaresExpectedVersion(operation.input);
  const expectedVersionRequired = (operation.input.required ?? []).includes(EXPECTED_VERSION_PROPERTY);

  const entryQuery = useQuery<EntryEditorPayload>({
    refetchOnMount: "always",
    queryKey: ["entry-editor", row?.collection ?? "", row?.id ?? ""],
    queryFn: () => {
      if (!row) throw new Error("row operation is missing its row");
      return api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(row.id)}`);
    },
    enabled: Boolean(row),
  });

  const prefillValue = React.useMemo(() => {
    if (!row) return undefined;
    if (rowField === "id") return row.id;
    return entryQuery.data?.entry.data[rowField] ?? undefined;
  }, [entryQuery.data, row, rowField]);

  const automaticInputFields = React.useMemo(
    () => automaticOperationInputFields(operation.input),
    [operation.input],
  );
  const [formValue, setFormValue] = React.useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      automaticInputFields
        .filter((name) => name !== EXPECTED_VERSION_PROPERTY)
        .map((name) => [name, crypto.randomUUID()]),
    ),
  );
  React.useEffect(() => {
    if (prefillValue === undefined || !inputField) return;
    setFormValue((prev) => ({ ...prev, [inputField]: prefillValue }));
  }, [prefillValue, inputField]);

  const occTargetId = resolveOccTargetId({
    input: operation.input,
    formValue,
    row,
    binding,
    rowBindings: operation.rowBindings,
    targetCollection: operation.targetCollection,
  });
  const capturedVersion = React.useRef<{ id: string; version: number } | null>(null);
  const [needsReread, setNeedsReread] = React.useState(false);

  React.useEffect(() => {
    if (!hasExpectedVersion) return;
    if (capturedVersion.current?.id === occTargetId) return;
    capturedVersion.current = null;
    setNeedsReread(false);
    setFormValue((prev) => {
      if (!(EXPECTED_VERSION_PROPERTY in prev)) return prev;
      const next = { ...prev };
      delete next[EXPECTED_VERSION_PROPERTY];
      return next;
    });
  }, [hasExpectedVersion, occTargetId]);

  const occEntryQuery = useQuery<EntryEditorPayload>({
    refetchOnMount: "always",
    queryKey: ["entry-editor", "occ", occTargetId ?? ""],
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(occTargetId!)}`),
    enabled: Boolean(hasExpectedVersion && occTargetId && occTargetId !== row?.id),
  });

  const occEntry =
    occTargetId && occTargetId === row?.id
      ? entryQuery.data?.entry
      : occEntryQuery.data?.entry;

  const observedQuery = occTargetId === row?.id ? entryQuery : occEntryQuery;
  const activeTarget = React.useRef(occTargetId);
  activeTarget.current = occTargetId;

  React.useEffect(() => {
    if (!observedQuery.isSuccess || !observedQuery.isFetchedAfterMount || observedQuery.isFetching) return;
    if (!hasExpectedVersion || !occTargetId || !occEntry || occEntry.id !== occTargetId) return;
    if (capturedVersion.current?.id === occTargetId) return;
    capturedVersion.current = { id: occTargetId, version: occEntry.version };
    setFormValue((prev) => ({ ...prev, [EXPECTED_VERSION_PROPERTY]: occEntry.version }));
  }, [hasExpectedVersion, occTargetId, occEntry, observedQuery.isSuccess, observedQuery.isFetchedAfterMount, observedQuery.isFetching]);

  const editableSchema = React.useMemo(() => {
    return operationFormSchema(operation.input, [
      ...(inputField ? [inputField] : []),
      ...automaticInputFields,
    ]);
  }, [automaticInputFields, operation.input, inputField]);

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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["entry-editor"] });
      toast.success(t(language, "ops.success", { name: title }));
      onSuccess();
    },
    onError: (error) => {
      if (hasExpectedVersion && error instanceof ApiError && error.status === 409 &&
          (error.body as { diagnostic?: { code?: string } } | null)?.diagnostic?.code === "CONFLICT") setNeedsReread(true);
    },
  });

  const reread = useMutation({
    mutationFn: async (id: string) => {
      const result = await observedQuery.refetch({ throwOnError: true });
      if (!result.data || result.data.entry.id !== id) throw new Error("Version target changed.");
      return result.data.entry;
    },
    onSuccess: (entry) => {
      if (activeTarget.current !== entry.id) return;
      capturedVersion.current = { id: entry.id, version: entry.version };
      setFormValue((prev) => ({ ...prev, [EXPECTED_VERSION_PROPERTY]: entry.version }));
      setNeedsReread(false);
      invoke.reset();
    },
  });

  const versionReady = operationVersionReady({
    declaresExpectedVersion: hasExpectedVersion,
    expectedVersionRequired,
    capturedVersion: formValue[EXPECTED_VERSION_PROPERTY],
    occTargetId,
    boundRow: Boolean(row),
  });
  const canSubmit = (!inputField || prefillValue !== undefined) && versionReady && !needsReread;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent closeLabel={t(language, "common.close")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {row && entryQuery.isLoading ? (
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
              uiSchema={operation.uiSchema}
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

        {row && entryQuery.isError ? <ErrorBox error={entryQuery.error} /> : null}
        {occEntryQuery.isError ? <ErrorBox error={occEntryQuery.error} /> : null}
        {reread.isError ? <ErrorBox error={reread.error} /> : null}
        {invoke.isError ? <OperationErrorBox error={asRenderable(invoke.error)} /> : null}
        {needsReread ? (
          <p className="text-sm text-muted-foreground">{t(language, "ops.conflict.rereadRequired")}</p>
        ) : null}

        {invoke.isSuccess ? (
          <section aria-label={t(language, "ops.output")} className="min-w-0 space-y-2">
            <h3 className="text-sm font-semibold">{t(language, "ops.output")}</h3>
            <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs" tabIndex={0}>
              {JSON.stringify(invoke.data.output ?? null, null, 2)}
            </pre>
          </section>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={invoke.isPending}>
            {t(language, invoke.isSuccess ? "common.close" : "rowActions.cancel")}
          </Button>
          {needsReread ? (
            <Button type="button" variant="secondary" onClick={() => occTargetId && reread.mutate(occTargetId)} disabled={invoke.isPending || reread.isPending}>
              {t(language, "ops.conflict.reread")}
            </Button>
          ) : null}
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
