import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@aotter/mantle-ui/kit";
import { t } from "../../app/i18n";
import type { AdminLanguage } from "../../app/preferences";
import { api, ApiError } from "../../lib/api";
import { listRowTitle } from "../../lib/entry-title";
import { resolveLocalizedText } from "../../lib/localized-text";
import { entryApiPath } from "../../lib/queries";
import type { Collection, EntryEditorPayload, EntryRow, ListEntriesResult } from "../../lib/types";
import { cn } from "../../lib/utils";
import { idTail } from "./field-render";

/** How many records the picker lists per search; it narrows by typing, it does not page. */
export const REF_PICKER_LIMIT = 20;

/**
 * Records of the target collection for one search term, read as the caller through the entries list route; with a
 * scope, only one parent's children (`scope_field`/`scope_value`, as the folded child list reads them).
 */
export function refOptionsQueryOptions(collection: string, term: string, scope?: { field: string; value: string }) {
  return {
    queryKey: ["entries", "ref-options", collection, term, ...(scope ? [scope.field, scope.value] : [])] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) => {
      const qs = new URLSearchParams({ collection, limit: String(REF_PICKER_LIMIT), sort: "updatedAt", direction: "desc" });
      if (term) qs.set("search", term);
      if (scope) {
        qs.set("scope_field", scope.field);
        qs.set("scope_value", scope.value);
      }
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`, signal ? { signal } : {});
    },
    retry: false,
    // a refusal stands for this page: another field or dialog over the same target keeps its text input without asking again
    retryOnMount: false,
  };
}

/** The record a stored reference value names, for its title. */
export function refLookupQueryOptions(collection: string, field: string, value: string) {
  return {
    queryKey: ["entries", "ref-lookup", collection, field, value] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) => {
      const qs = new URLSearchParams({ collection, filter_field: field, filter_value: value, limit: "1" });
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`, signal ? { signal } : {});
    },
    retry: false,
  };
}

/** The caller cannot list the target (no read grant, or no such Admin collection): the plain input stays. */
export function refPickerUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/** The value a row stores in the referencing field: its id, or the referenced key field when the list carries it. */
function storedValue(row: EntryRow & { data?: Record<string, unknown> }, field: string): unknown {
  if (field === "id") return row.id;
  return row.data?.[field] ?? row.data_preview?.[field];
}

/**
 * A searchable picker for an `x-mantle-ref` field: it lists the target collection through the same authorized
 * entries route as the list page and stores the referenced value (the id unless the ref names another key).
 * Convenience only: the server validates the value, and anything the caller cannot list keeps the text input.
 */
export function RefPicker({ target, scope, value, onChange, onClear, label, language, canonical = null, fallback }: {
  target: { schema: string; field: string };
  /** Lists only one parent's children (an operation bound to that parent); the stored value is still looked up unscoped. */
  scope?: { field: string; value: string } | undefined;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Empties an optional field (to null in a record form; never ""); without it there is no clear button. */
  onClear?: (() => void) | undefined;
  label: string;
  language: AdminLanguage;
  canonical?: string | null;
  /** The field's plain control, used whenever the picker cannot list the target. */
  fallback: () => React.ReactNode;
}): React.ReactElement {
  const collections = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => (await api.get<{ collections: Collection[] }>("/collections")).collections,
  });
  const collection = collections.data?.find((item) => item.name === target.schema);
  // the first page doubles as the probe: a refusal keeps the text input before anyone opens the list
  const probe = useQuery({ ...refOptionsQueryOptions(target.schema, "", scope), enabled: Boolean(collection) });
  if (!collection || refPickerUnavailable(probe.error)) return <>{fallback()}</>;
  return <RefCombobox collection={collection} field={target.field} scope={scope} value={value} onChange={onChange} onClear={onClear} label={label} language={language} canonical={canonical} />;
}

function RefCombobox({ collection, field, scope, value, onChange, onClear, label, language, canonical }: {
  collection: Collection;
  field: string;
  scope: { field: string; value: string } | undefined;
  value: unknown;
  onChange: (next: unknown) => void;
  onClear: (() => void) | undefined;
  label: string;
  language: AdminLanguage;
  canonical: string | null;
}): React.ReactElement {
  const baseId = React.useId();
  const listId = `${baseId}-list`;
  const [open, setOpen] = React.useState(false);
  const [term, setTerm] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [picking, setPicking] = React.useState(false);
  const [pickError, setPickError] = React.useState(false);
  const search = React.useDeferredValue(term.trim());
  const name = resolveLocalizedText(collection.title, language, canonical) ?? collection.name;
  const options = useQuery({ ...refOptionsQueryOptions(collection.name, search, scope), enabled: open || search === "" });
  const stored = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const lookup = useQuery({ ...refLookupQueryOptions(collection.name, field, stored), enabled: stored !== "" });
  const current = lookup.data?.items[0];
  const items = options.data?.items ?? [];
  React.useEffect(() => setActive(0), [search, open]);

  const choose = async (row: EntryRow) => {
    let next = storedValue(row, field);
    if (next === undefined) {
      // a key field the list does not carry: read the record once for it
      setPicking(true);
      try {
        const payload = await api.get<EntryEditorPayload>(entryApiPath(collection.name, row.id));
        next = payload.entry.data?.[field];
      } catch {
        next = undefined;
      } finally {
        setPicking(false);
      }
      if (next === undefined) { setPickError(true); return; }
    }
    setPickError(false);
    onChange(next);
    setTerm("");
    setOpen(false);
  };
  const clear = () => { onClear?.(); setTerm(""); setOpen(false); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(items.length - 1, 0))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(Math.max(items.length - 1, 0)); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const row = items[active];
      if (row && !picking) void choose(row);
    }
  };
  const currentTitle = current ? listRowTitle(current, collection, language) : undefined;
  const activeId = items[active] ? `${baseId}-option-${active}` : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2">
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" aria-haspopup="listbox" aria-label={label}
            className="h-9 min-w-0 flex-1 justify-between font-normal" data-ref-picker={collection.name}>
            <span className={cn("truncate", !stored && "text-muted-foreground")}>
              {stored ? (currentTitle ?? stored) : t(language, "refPicker.choose", { name })}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {stored && currentTitle ? <span className="font-mono text-xs text-muted-foreground" title={stored}>{idTail(stored)}</span> : null}
              <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
            </span>
          </Button>
        </PopoverTrigger>
        {stored && onClear ? (
          <Button type="button" variant="ghost" size="icon-sm" onClick={clear} aria-label={t(language, "refPicker.clear", { name: label })} title={t(language, "refPicker.clear", { name: label })}>
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 gap-2 p-2">
        <Input
          autoFocus
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label={t(language, "refPicker.search", { name })}
          placeholder={t(language, "refPicker.search", { name })}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <RefOptionList id={listId} baseId={baseId} items={items} active={active} selected={stored} field={field}
          collection={collection} language={language} label={label}
          status={options.isError ? "error" : options.data ? "ready" : "loading"}
          onHover={setActive} onChoose={(row) => void choose(row)} />
        {pickError ? <p role="alert" className="px-1 text-xs text-destructive">{t(language, "refPicker.error")}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The listbox of candidate records; exported so its markup can be checked without opening a popover. */
export function RefOptionList({ id, baseId, items, active, selected, field, collection, language, label, status, onHover, onChoose }: {
  id: string;
  baseId: string;
  items: readonly EntryRow[];
  active: number;
  selected: string;
  field: string;
  collection: Pick<Collection, "list">;
  language: AdminLanguage;
  label: string;
  status: "loading" | "error" | "ready";
  onHover: (index: number) => void;
  onChoose: (row: EntryRow) => void;
}): React.ReactElement {
  if (status !== "ready" || items.length === 0) {
    const message = status === "loading" ? "refPicker.loading" : status === "error" ? "refPicker.error" : "refPicker.empty";
    return <p id={id} role="status" className="px-3 py-2 text-sm text-muted-foreground">{t(language, message)}</p>;
  }
  return (
    <ul id={id} role="listbox" aria-label={label} className="max-h-56 overflow-y-auto text-sm">
      {items.map((row, index) => {
        const value = storedValue(row, field);
        const isSelected = selected !== "" && value !== undefined && String(value) === selected;
        return (
          <li
            key={row.id}
            id={`${baseId}-option-${index}`}
            role="option"
            aria-selected={isSelected}
            data-active={index === active || undefined}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 data-active:bg-accent"
            onMouseEnter={() => onHover(index)}
            // keep focus in the search box; the click picks
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(row)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Check className={cn("size-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")} aria-hidden />
              <span className="truncate">{listRowTitle(row, collection, language)}</span>
            </span>
            <span className="font-mono text-xs text-muted-foreground">{idTail(row.id)}</span>
          </li>
        );
      })}
    </ul>
  );
}
