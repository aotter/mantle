import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  FileText,
  PencilLine,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useAdminLocation } from "../../app/router";
import { api } from "../../lib/api";
import { fieldLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { operationsQueryOptions } from "../../lib/queries";
import type {
  Collection,
  EntryEditorPayload,
  EntryRow,
  ListEntriesResult,
  SiteInfo,
  StaffOperation,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { TableCell, TableHeadCell, TableShell } from "../../ui/admin-table";
import { CollapsibleDescription, EmptyState, ErrorBox, PageHeader } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { statusLabel } from "./status";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { formatMoneyMinor, formatTimestampMs, moneyMinorHint, timestampHint } from "./field-render";
import { boundOperationsFor, RowOperationsMenu } from "./row-operations";

const TIMESTAMP_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

export function CollectionView({
  collectionName,
}: {
  collectionName: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(location.search);
  const status = params.get("status") ?? undefined;
  const searchTerm = params.get("search")?.trim() ?? "";

  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const canonical = site.data?.canonicalLocale ?? null;
  // #430 row actions — same query key as `authenticated-layout.tsx` /
  // `operations-view.tsx` (`operationsQueryOptions()`), so this hits
  // react-query's cache instead of triggering a duplicate fetch.
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
  const boundOperations = React.useMemo(
    () => boundOperationsFor(operationsQuery.data, collectionName),
    [operationsQuery.data, collectionName],
  );
  const entries = useQuery<ListEntriesResult>({
    queryKey: ["entries", collectionName, status ?? "all", language, searchTerm],
    queryFn: () => {
      const qs = new URLSearchParams({
        collection: collectionName,
        limit: "99",
        locale: language,
      });
      if (status) qs.set("status", status);
      if (searchTerm) qs.set("search", searchTerm);
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
    },
  });
  const [visibleEntries, setVisibleEntries] = React.useState<ListEntriesResult | null>(null);
  React.useEffect(() => {
    if (entries.data) setVisibleEntries(entries.data);
  }, [entries.data]);
  // Appended "load more" pages live in their own state, separate from
  // the page-1 query. Reset whenever page 1 itself changes — a new
  // collection/status/search/language combo, or a refetch of the
  // current combo after a mutation — since stale appended pages would
  // otherwise duplicate or drift out of sync with a fresh page 1.
  const [extraItems, setExtraItems] = React.useState<EntryRow[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = React.useState<unknown>(null);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  React.useEffect(() => {
    setExtraItems([]);
    setNextCursor(entries.data?.next_cursor ?? null);
    setLoadMoreError(null);
  }, [collectionName, status, searchTerm, language, entries.data]);
  const displayedEntries = React.useMemo(() => {
    const base = entries.data ?? visibleEntries;
    if (!base) return base;
    return { ...base, items: [...base.items, ...extraItems] };
  }, [entries.data, visibleEntries, extraItems]);
  const isFirstLoad = entries.isLoading && !displayedEntries;

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  const collection = collectionsQuery.data?.find((c) => c.name === collectionName);
  const heading = collection
    ? resolveLocalizedText(collection.title, language, canonical) ?? collection.name
    : collectionName;
  const isOperationalCollection = collection?.lifecycle === "none";
  const dataColumns = React.useMemo(() => dataPreviewColumns(collection), [collection]);
  const refreshEntries = React.useCallback(() => {
    clearSelection();
    void queryClient.invalidateQueries({ queryKey: ["entries", collectionName] });
  }, [collectionName, queryClient, clearSelection]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const qs = new URLSearchParams({
        collection: collectionName,
        limit: "99",
        locale: language,
        cursor: nextCursor,
      });
      if (status) qs.set("status", status);
      if (searchTerm) qs.set("search", searchTerm);
      const page = await api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
      setExtraItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      setLoadMoreError(err);
    } finally {
      setIsLoadingMore(false);
    }
  }

  const titleMutation = useMutation({
    mutationFn: ({ id, title, version }: { id: string; title: string; version: number }) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(id)}`, {
        data: { title },
        expectedVersion: version,
      }),
    onSuccess: refreshEntries,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ removed: boolean }>(`/entries/${encodeURIComponent(id)}`),
    onSuccess: refreshEntries,
  });
  // POST an empty draft and land in the schema-driven editor — no
  // modal, no pre-fill; the manifest form takes over from there.
  const createMutation = useMutation({
    mutationFn: () =>
      api.post<EntryEditorPayload>("/entries", { collection: collectionName, data: {} }),
    onSuccess: (payload) => {
      window.location.href = `/admin/c/${encodeURIComponent(collectionName)}/${encodeURIComponent(payload.entry.id)}`;
    },
  });

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <a href="/admin" className="hover:underline">
              {t(language, "collection.breadcrumb")}
            </a>
            <span className="mx-2 text-foreground/30">/</span>
            <span className="text-foreground/70">{collectionName}</span>
          </>
        }
        title={heading}
        description={renderCollectionDescription(collection, language, canonical)}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                window.location.href = `/admin/api/entries/export?collection=${encodeURIComponent(collectionName)}`;
              }}
            >
              <Download className="size-4" aria-hidden />
              {t(language, "collection.export")}
            </Button>
            <Button
              type="button"
              variant={isOperationalCollection ? "ghost" : "default"}
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              <Plus className="size-4" aria-hidden />
              {createMutation.isPending
                ? t(language, "crud.saving")
                : t(language, "collection.create")}
            </Button>
            {status ? <StatusBadge status={status} /> : null}
            {collection?.hasTranslations ? (
              <span className="badge-status bg-accent text-accent-foreground">i18n</span>
            ) : null}
            {collection?.mediaFields?.length ? (
              <span className="badge-status bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[color:var(--success)]">
                media
              </span>
            ) : null}
          </div>
        }
      />

      {createMutation.isError ? <ErrorBox error={createMutation.error} /> : null}

      {collection ? (
        <CollectionSearch
          collectionName={collection.name}
          status={status}
          searchTerm={searchTerm}
          language={language}
        />
      ) : null}

      {collection && collection.lifecycle !== "none" ? (
        <StatusFilter
          collection={collection}
          activeStatus={status}
          searchTerm={searchTerm}
          language={language}
        />
      ) : null}

      {isFirstLoad && <EntriesSkeleton />}
      {entries.isError && !displayedEntries && <ErrorBox error={entries.error} />}
      {displayedEntries && displayedEntries.items.length === 0 && (
        <EmptyState
          icon={FileText}
          title={t(language, "collection.empty.title")}
          description={
            searchTerm
              ? t(language, "collection.empty.search", { search: searchTerm })
              : status
              ? t(language, "collection.empty.withStatus", { status })
              : t(language, "collection.empty.all")
          }
        />
      )}
      {displayedEntries && displayedEntries.items.length > 0 && (
        <>
          {selected.size > 0 ? (
            <BulkActionBar
              language={language}
              collection={collection}
              selectedIds={[...selected]}
              onDone={refreshEntries}
              onClear={clearSelection}
            />
          ) : null}
          <TableShell>
            <thead>
              <tr className="border-b border-[var(--glass-border)]">
                <TableHeadCell className="w-10">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    aria-label={t(language, "collection.table.selectAll")}
                    checked={selected.size > 0 && displayedEntries.items.every((row) => selected.has(row.id))}
                    ref={(el) => {
                      if (!el) return;
                      const someSelected = displayedEntries.items.some((row) => selected.has(row.id));
                      const allSelected = displayedEntries.items.every((row) => selected.has(row.id));
                      el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={(event) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const row of displayedEntries.items) {
                          if (event.target.checked) next.add(row.id);
                          else next.delete(row.id);
                        }
                        return next;
                      });
                    }}
                  />
                </TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.id")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.title")}</TableHeadCell>
                {isOperationalCollection ? (
                  dataColumns.map((name) => <TableHeadCell key={name}>{fieldLabel(name)}</TableHeadCell>)
                ) : (
                  <>
                    <TableHeadCell>{t(language, "collection.table.status")}</TableHeadCell>
                    <TableHeadCell>{t(language, "collection.table.locale")}</TableHeadCell>
                    <TableHeadCell>{t(language, "collection.table.version")}</TableHeadCell>
                  </>
                )}
                <TableHeadCell>{t(language, "collection.table.updated")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.actions")}</TableHeadCell>
              </tr>
            </thead>
            <tbody>
              {displayedEntries.items.map((row) => (
                <EntryRowDisplay
                  key={row.id}
                  row={row}
                  language={language}
                  canonical={canonical}
                  collection={collection}
                  dataColumns={isOperationalCollection ? dataColumns : null}
                  boundOperations={boundOperations}
                  onOperationSuccess={refreshEntries}
                  selected={selected.has(row.id)}
                  onToggleSelect={(checked) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(row.id);
                      else next.delete(row.id);
                      return next;
                    });
                  }}
                  onRename={(title) => titleMutation.mutateAsync({ id: row.id, title, version: row.version })}
                  onDelete={() => deleteMutation.mutateAsync(row.id)}
                  busy={
                    (titleMutation.isPending && titleMutation.variables?.id === row.id) ||
                    (deleteMutation.isPending && deleteMutation.variables === row.id)
                  }
                />
              ))}
            </tbody>
          </TableShell>
          {entries.isFetching && !entries.data ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t(language, "collection.refreshing")}
            </p>
          ) : null}
          {loadMoreError ? <ErrorBox error={loadMoreError} /> : null}
          {nextCursor ? (
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? t(language, "crud.saving") : t(language, "collection.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function BulkActionBar({
  language,
  collection,
  selectedIds,
  onDone,
  onClear,
}: {
  language: AdminLanguage;
  collection: Collection | undefined;
  selectedIds: string[];
  onDone: () => void;
  onClear: () => void;
}): React.ReactElement {
  const [pending, setPending] = React.useState<"publish" | "unpublish" | "delete" | null>(null);
  const [failures, setFailures] = React.useState<unknown[]>([]);
  const canPublish = collection && collection.lifecycle !== "none";

  async function runBulk(
    action: "publish" | "unpublish" | "delete",
    call: (id: string) => Promise<unknown>,
  ): Promise<void> {
    setPending(action);
    setFailures([]);
    const errors: unknown[] = [];
    for (const id of selectedIds) {
      try {
        await call(id);
      } catch (err) {
        errors.push(err);
      }
    }
    setPending(null);
    setFailures(errors);
    onDone();
  }

  function bulkDelete(): void {
    if (
      typeof window !== "undefined" &&
      !window.confirm(t(language, "collection.bulk.deleteConfirm", { count: String(selectedIds.length) }))
    ) {
      return;
    }
    void runBulk("delete", (id) => api.delete(`/entries/${encodeURIComponent(id)}`));
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--glass-border)] bg-accent/40 px-3 py-2">
      <span className="text-sm font-medium">
        {t(language, "collection.bulk.selectedCount", { count: String(selectedIds.length) })}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {canPublish ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void runBulk("publish", (id) => api.post(`/entries/${encodeURIComponent(id)}/publish`, {}))
              }
            >
              {t(language, "collection.bulk.publish")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                void runBulk("unpublish", (id) => api.post(`/entries/${encodeURIComponent(id)}/unpublish`, {}))
              }
            >
              {t(language, "collection.bulk.unpublish")}
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending !== null}
          onClick={bulkDelete}
        >
          {t(language, "collection.bulk.delete")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {failures.length > 0 ? (
        <div className="w-full space-y-1">
          {failures.map((err, index) => (
            <ErrorBox key={index} error={err} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CollectionSearch({
  collectionName,
  status,
  searchTerm,
  language,
}: {
  collectionName: string;
  status: string | undefined;
  searchTerm: string;
  language: AdminLanguage;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(searchTerm);
  React.useEffect(() => setDraft(searchTerm), [searchTerm]);
  return (
    <form
      className="mb-3 max-w-xl"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        if (next) params.set("search", next);
        const suffix = params.toString();
        window.location.href = `/admin/c/${encodeURIComponent(collectionName)}${suffix ? `?${suffix}` : ""}`;
      }}
    >
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          className="admin-input h-10 pl-9"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t(language, "collection.searchPlaceholder")}
        />
      </label>
    </form>
  );
}

function renderCollectionDescription(
  collection: Collection | undefined,
  language: AdminLanguage,
  canonical: string | null,
): React.ReactNode {
  const resolvedTitle = collection ? resolveLocalizedText(collection.title, language, canonical) ?? collection.name : "";
  const raw = resolveLocalizedText(collection?.description, language, canonical)?.trim();
  if (!raw) return t(language, "collection.defaultDescription");

  return (
    <CollapsibleDescription
      description={raw}
      summaryLabel={t(language, "collection.schemaDetails")}
      collapsedIntro={t(language, "collection.schemaSummary", {
        name: resolvedTitle,
      })}
    />
  );
}

function StatusFilter({
  collection,
  activeStatus,
  searchTerm,
  language,
}: {
  collection: Collection;
  activeStatus: string | undefined;
  searchTerm: string;
  language: AdminLanguage;
}): React.ReactElement {
  const statuses = collection.lifecycle === "editorial"
    ? (["draft", "review", "published", "archived"] as const)
    : (["draft", "published", "archived"] as const);

  return (
    <div className="mb-5 flex gap-2 overflow-x-auto pb-1" data-tour="status-filter">
      <StatusFilterLink
        href={collectionFilterHref(collection.name, undefined, searchTerm)}
        active={!activeStatus}
      >
        {t(language, "collection.filter.all")}
      </StatusFilterLink>
      {statuses.map((s) => (
        <StatusFilterLink
          key={s}
          href={collectionFilterHref(collection.name, s, searchTerm)}
          active={activeStatus === s}
        >
          {statusLabel(language, s)}
        </StatusFilterLink>
      ))}
    </div>
  );
}

function collectionFilterHref(
  collectionName: string,
  status: string | undefined,
  searchTerm: string,
): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (searchTerm) params.set("search", searchTerm);
  const suffix = params.toString();
  return `/admin/c/${encodeURIComponent(collectionName)}${suffix ? `?${suffix}` : ""}`;
}

function StatusFilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border px-3 text-xs font-medium",
        "transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "border-[var(--glass-border)] bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </a>
  );
}

function EntriesSkeleton(): React.ReactElement {
  return (
    <div className="glass-card overflow-hidden">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-[var(--glass-border)] p-3 last:border-b-0"
        >
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
          <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}

/** Truncated ID cell that copies the full id on click, mirroring the
 *  `CopyField` pattern in `ui/page.tsx` (brief check-mark state via a
 *  timeout, no shared state beyond this row). */
function CopyIdButton({ id, language }: { id: string; language: AdminLanguage }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1 hover:text-foreground"
      title={t(language, "collection.copyId")}
      onClick={() => void copy()}
    >
      {id.slice(0, 8)}
      {copied ? (
        <Check className="size-3 text-[color:var(--success)]" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-40 transition-opacity group-hover:opacity-80" aria-hidden />
      )}
    </button>
  );
}

function EntryRowDisplay({
  row,
  language,
  canonical,
  collection,
  dataColumns,
  boundOperations,
  onOperationSuccess,
  selected,
  onToggleSelect,
  onRename,
  onDelete,
  busy,
}: {
  row: EntryRow;
  language: AdminLanguage;
  canonical: string | null;
  collection: Collection | undefined;
  /** Non-null (possibly empty) for `lifecycle: "none"` collections —
   *  swaps the status/locale/version cells for these data columns. */
  dataColumns: string[] | null;
  /** Staff operations (#430) whose `rowBindings` include this
   *  collection — renders the "⋯" row-action menu only when non-empty. */
  boundOperations: StaffOperation[];
  onOperationSuccess: () => void;
  selected: boolean;
  onToggleSelect: (checked: boolean) => void;
  onRename: (title: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  busy: boolean;
}): React.ReactElement {
  const itemName = renderTitleText(row.title, language);
  const [editing, setEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(itemName);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!editing) setDraftTitle(itemName);
  }, [editing, itemName]);

  async function saveTitle(): Promise<void> {
    const next = draftTitle.trim();
    if (!next || next === itemName) {
      setEditing(false);
      setDraftTitle(itemName);
      return;
    }
    setError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(): Promise<void> {
    if (typeof window !== "undefined" && !window.confirm(t(language, "crud.deleteConfirm", { name: itemName }))) {
      return;
    }
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <tr className="border-t border-[var(--glass-border)] hover:bg-accent/40">
      <TableCell>
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          aria-label={t(language, "collection.table.selectRow", { name: itemName })}
          checked={selected}
          onChange={(event) => onToggleSelect(event.target.checked)}
        />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        <CopyIdButton id={String(row.id)} language={language} />
      </TableCell>
      <TableCell className="max-w-[28rem]">
        <div className="min-w-[16rem]">
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                className="admin-input h-9 min-w-0 flex-1"
                value={draftTitle}
                autoFocus
                disabled={busy}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveTitle();
                  if (event.key === "Escape") {
                    setDraftTitle(itemName);
                    setEditing(false);
                  }
                }}
              />
              <button type="button" className="row-action" title={t(language, "crud.saveTitle")} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => void saveTitle()}>
                <Check className="size-3.5" aria-hidden />
              </button>
              <button type="button" className="row-action" title={t(language, "crud.cancelTitle")} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => { setDraftTitle(itemName); setEditing(false); }}>
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="group inline-flex max-w-full items-center gap-2 text-left"
              onClick={() => setEditing(true)}
              title={itemName}
            >
              <span className="truncate">{renderTitle(row.title, language)}</span>
              <PencilLine className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
            </button>
          )}
          {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
        </div>
      </TableCell>
      {dataColumns ? (
        dataColumns.map((name) => (
          <TableCell key={name} className="text-muted-foreground">
            {renderDataPreviewValue(collection, name, row.data_preview?.[name])}
          </TableCell>
        ))
      ) : (
        <>
          <TableCell>
            <StatusBadge status={row.status} />
          </TableCell>
          <TableCell className="text-muted-foreground">{row.locale ?? "-"}</TableCell>
          <TableCell className="font-mono text-xs text-muted-foreground">
            v{row.version}
          </TableCell>
        </>
      )}
      <TableCell className="text-muted-foreground">
        {formatTimestamp(row.updated_at)}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1" data-tour="entry-actions">
          <a className="row-action" title={t(language, "crud.editTooltip", { name: itemName })} href={`/admin/c/${encodeURIComponent(row.collection)}/${encodeURIComponent(row.id)}`}>
            <PencilLine className="size-3.5" aria-hidden />
          </a>
          <button type="button" className="row-action" title={t(language, "crud.deleteTooltip", { name: itemName })} disabled={busy} onClick={() => void remove()}>
            <Trash2 className="size-3.5" aria-hidden />
          </button>
          <RowOperationsMenu
            row={row}
            operations={boundOperations}
            language={language}
            canonical={canonical}
            onSuccess={onOperationSuccess}
          />
        </div>
        <span className="sr-only">
          {collection ? resolveLocalizedText(collection.title, language, canonical) ?? collection.name : ""}
        </span>
      </TableCell>
    </tr>
  );
}

function renderTitle(
  title: unknown,
  language: AdminLanguage,
): React.ReactNode {
  if (title == null || title === "") {
    return (
      <span className="text-muted-foreground">
        {t(language, "collection.untitled")}
      </span>
    );
  }
  if (typeof title === "string") return title;
  return <span className="font-mono text-xs">{JSON.stringify(title)}</span>;
}

function renderTitleText(title: unknown, language: AdminLanguage): string {
  if (typeof title === "string" && title) return title;
  if (title == null || title === "") return t(language, "collection.untitled");
  return JSON.stringify(title);
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  try {
    return TIMESTAMP_FMT.format(new Date(ms));
  } catch {
    return "-";
  }
}

/** For `lifecycle: "none"` collections: up to 3 data columns from the
 *  schema's `required` properties, skipping the schema-stable title
 *  field. MUST mirror `schemaTitleKey` / `adminDataPreview` server-side
 *  in `mountServerEndpoints.ts` — both sides derive from the schema
 *  alone so headers and cell values can never disagree. */
function dataPreviewColumns(collection: Collection | undefined): string[] {
  if (!collection || collection.lifecycle !== "none") return [];
  const schema = collection.schema;
  const required = schema?.required ?? [];
  const properties = schema?.properties ?? {};
  const titleKey =
    ["title", "name", "slug"].find((key) => key in properties) ??
    required.find((key) => {
      const raw = properties[key]?.type;
      const types = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return types.includes("string");
    }) ??
    null;
  return required.filter((key) => key !== titleKey).slice(0, 3);
}

/** Renders one operational data-preview cell, applying money/timestamp
 *  formatting when the schema property carries the matching hint. */
function renderDataPreviewValue(
  collection: Collection | undefined,
  fieldName: string,
  value: unknown,
): React.ReactNode {
  const fieldSchema = collection?.schema?.properties?.[fieldName];
  if (moneyMinorHint(fieldSchema)) {
    const formatted = formatMoneyMinor(value, undefined);
    if (formatted) return formatted;
  }
  if (timestampHint(fieldSchema)) {
    const formatted = formatTimestampMs(value);
    if (formatted) return formatted;
  }
  if (value == null || value === "") return <span className="text-muted-foreground">-</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
}
