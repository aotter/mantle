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
import { propertyLabel } from "../../lib/field-label";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirm } from "../../ui/confirm-dialog";
import { CollapsibleDescription, EmptyState, ErrorBox, PageHeader } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { statusLabel } from "./status";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t, type I18nKey } from "../../app/i18n";
import { formatTimestampMs, idTail } from "./field-render";
import { boundOperationsFor, RowOperationsMenu } from "./row-operations";
import { useCursorPagination } from "../../lib/use-cursor-pagination";
import { renderDataValue } from "../../lib/render-data-value";
import { renderTitleText } from "../../lib/entry-title";

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
  const loadEntriesPage = React.useCallback(async (cursor: string) => {
    const qs = new URLSearchParams({
      collection: collectionName,
      limit: "99",
      locale: language,
      cursor,
    });
    if (status) qs.set("status", status);
    if (searchTerm) qs.set("search", searchTerm);
    return api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
  }, [collectionName, language, searchTerm, status]);
  const baseEntries = entries.data ?? visibleEntries;
  const pagination = useCursorPagination<EntryRow>(baseEntries, {
    resetKey: `${collectionName}:${status ?? "all"}:${language}:${searchTerm}`,
    resetOnPageChange: true,
    loadPage: loadEntriesPage,
  });
  const displayedEntries = React.useMemo(() => {
    if (!baseEntries) return baseEntries;
    return { ...baseEntries, items: pagination.items };
  }, [baseEntries, pagination.items]);
  const isFirstLoad = entries.isLoading && !displayedEntries;

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  const collection = collectionsQuery.data?.find((c) => c.name === collectionName);
  const heading = collection
    ? resolveLocalizedText(collection.title, language, canonical) ?? collection.name
    : collectionName;
  const isOperationalCollection = collection?.lifecycle === "operational";
  const dataColumns = React.useMemo(() => dataPreviewColumns(collection), [collection]);
  const refreshEntries = React.useCallback(() => {
    clearSelection();
    void queryClient.invalidateQueries({ queryKey: ["entries", collectionName] });
  }, [collectionName, queryClient, clearSelection]);

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
            {collection && !isOperationalCollection ? (
              <Button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
              >
                <Plus className="size-4" aria-hidden />
                {createMutation.isPending
                  ? t(language, "crud.saving")
                  : t(language, "collection.create")}
              </Button>
            ) : null}
            {status ? <StatusBadge status={status} /> : null}
            {collection?.hasTranslations ? (
              <Badge variant="secondary">i18n</Badge>
            ) : null}
            {collection?.mediaFields?.length ? (
              <Badge variant="outline" className="text-success">
                media
              </Badge>
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

      {collection && collection.lifecycle !== "operational" ? (
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={t(language, "collection.table.selectAll")}
                    checked={
                      displayedEntries.items.every((row) => selected.has(row.id))
                        ? true
                        : displayedEntries.items.some((row) => selected.has(row.id))
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(checked) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const row of displayedEntries.items) {
                          if (checked === true) next.add(row.id);
                          else next.delete(row.id);
                        }
                        return next;
                      });
                    }}
                  />
                </TableHead>
                <TableHead>{t(language, "collection.table.id")}</TableHead>
                <TableHead>
                  {isOperationalCollection
                    ? propertyLabel(
                        collectionTitleField(collection) ?? "title",
                        collection?.schema?.properties?.[collectionTitleField(collection) ?? ""],
                        language,
                        canonical,
                      )
                    : t(language, "collection.table.title")}
                </TableHead>
                {isOperationalCollection ? (
                  dataColumns.map((name) => (
                    <TableHead key={name}>
                      {propertyLabel(name, collection?.schema?.properties?.[name], language, canonical)}
                    </TableHead>
                  ))
                ) : (
                  <>
                    <TableHead>{t(language, "collection.table.status")}</TableHead>
                    <TableHead>{t(language, "collection.table.locale")}</TableHead>
                    <TableHead>{t(language, "collection.table.version")}</TableHead>
                  </>
                )}
                <TableHead>{t(language, "collection.table.updated")}</TableHead>
                <TableHead>{t(language, "collection.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
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
            </TableBody>
          </Table>
          {entries.isFetching && !entries.data ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t(language, "collection.refreshing")}
            </p>
          ) : null}
          {pagination.loadMoreError ? <ErrorBox error={pagination.loadMoreError} /> : null}
          {pagination.nextCursor ? (
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void pagination.loadMore()}
                disabled={pagination.isLoadingMore}
              >
                {pagination.isLoadingMore ? t(language, "crud.saving") : t(language, "collection.loadMore")}
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
  const [pending, setPending] = React.useState(false);
  const [failures, setFailures] = React.useState<unknown[]>([]);
  const canPublish = collection && collection.lifecycle !== "operational";
  const confirm = useConfirm();

  async function runBulk(call: (id: string) => Promise<unknown>): Promise<void> {
    setPending(true);
    setFailures([]);
    const errors: unknown[] = [];
    for (const id of selectedIds) {
      try {
        await call(id);
      } catch (err) {
        errors.push(err);
      }
    }
    setPending(false);
    setFailures(errors);
    onDone();
  }

  async function bulkDelete(): Promise<void> {
    const ok = await confirm({
      description: t(language, "collection.bulk.deleteConfirm", { count: String(selectedIds.length) }),
    });
    if (!ok) return;
    void runBulk((id) => api.delete(`/entries/${encodeURIComponent(id)}`));
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
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
              disabled={pending}
              onClick={() =>
                void runBulk((id) => api.post(`/entries/${encodeURIComponent(id)}/publish`, {}))
              }
            >
              {t(language, "collection.bulk.publish")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                void runBulk((id) => api.post(`/entries/${encodeURIComponent(id)}/unpublish`, {}))
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
          disabled={pending}
          onClick={() => void bulkDelete()}
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
        <Input
          className="h-9 ps-9"
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
  const summaryKey = collectionSummaryKey(collection);
  if (!raw) return t(language, summaryKey, { name: resolvedTitle });

  return (
    <CollapsibleDescription
      description={raw}
      summaryLabel={t(language, "collection.schemaDetails")}
      collapsedIntro={t(language, summaryKey, {
        name: resolvedTitle,
      })}
    />
  );
}

/** #444: the subtitle used to say "items, publishing state, and
 *  localized content" for every collection, including `lifecycle:
 *  "operational"` ones that have neither a publish workflow nor translations.
 *  Picks from four i18n variants using capabilities the UI already has
 *  on hand (`collection.lifecycle`, `collection.hasTranslations`) —
 *  same fields `CollectionView` already reads for
 *  `isOperationalCollection` / the `i18n` badge, no new server data. */
export function collectionSummaryKey(collection: Collection | undefined): I18nKey {
  const hasLifecycle = collection ? collection.lifecycle !== "operational" : true;
  const hasTranslations = collection?.hasTranslations ?? false;
  if (hasLifecycle && hasTranslations) return "collection.schemaSummary.lifecycleAndI18n";
  if (hasLifecycle) return "collection.schemaSummary.lifecycleOnly";
  if (hasTranslations) return "collection.schemaSummary.i18nOnly";
  return "collection.schemaSummary.plain";
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
    <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
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
          ? "border-border bg-secondary text-secondary-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </a>
  );
}

function EntriesSkeleton(): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b p-3 last:border-b-0"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Truncated ID cell that copies the full id on click, mirroring the
 *  `CopyField` pattern in `ui/page.tsx` (brief check-mark state via a
 *  timeout, no shared state beyond this row). #444: shows the TAIL of
 *  the id (`idTail`) rather than the head — ids share a `<prefix>_
 *  <collection>_` head across every row in a collection, so the head
 *  read as a meaningless constant. The full id is still one click
 *  away (copy) or a hover (title tooltip) away. */
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
      title={`${id} — ${t(language, "collection.copyId")}`}
      onClick={() => void copy()}
    >
      {idTail(id)}
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
  /** Non-null (possibly empty) for `lifecycle: "operational"` collections —
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
  const isOperational = dataColumns !== null;
  const [editing, setEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(itemName);
  const [error, setError] = React.useState<string | null>(null);
  const confirm = useConfirm();

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
    if (!(await confirm({ description: t(language, "crud.deleteConfirm", { name: itemName }) }))) {
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
    <TableRow>
      <TableCell>
        <Checkbox
          aria-label={t(language, "collection.table.selectRow", { name: itemName })}
          checked={selected}
          onCheckedChange={(checked) => onToggleSelect(checked === true)}
        />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        <CopyIdButton id={String(row.id)} language={language} />
      </TableCell>
      <TableCell className="max-w-[28rem]">
        <div className="min-w-[16rem]">
          {isOperational ? (
            <a
              href={`/admin/c/${encodeURIComponent(row.collection)}/${encodeURIComponent(row.id)}`}
              className="block truncate font-medium hover:underline"
              title={itemName}
            >
              {renderTitle(row.title, language)}
            </a>
          ) : editing ? (
            <div className="flex items-center gap-1">
              <Input
                className="h-8 min-w-0 flex-1"
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
              <Button type="button" variant="ghost" size="icon-sm" title={t(language, "crud.saveTitle")} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => void saveTitle()}>
                <Check className="size-3.5" aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" title={t(language, "crud.cancelTitle")} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => { setDraftTitle(itemName); setEditing(false); }}>
                <X className="size-3.5" aria-hidden />
              </Button>
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
            {renderDataValue(collection?.schema?.properties?.[name], row.data_preview?.[name])}
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
        {formatTimestampMs(row.updated_at) ?? "-"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="icon-sm">
            <a title={t(language, "crud.editTooltip", { name: itemName })} href={`/admin/c/${encodeURIComponent(row.collection)}/${encodeURIComponent(row.id)}`}>
              <PencilLine className="size-3.5" aria-hidden />
            </a>
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" title={t(language, "crud.deleteTooltip", { name: itemName })} disabled={busy} onClick={() => void remove()}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
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
    </TableRow>
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

/** Schema property names that collide in MEANING with a system column
 *  the admin list already renders unconditionally (the "updated"
 *  column reads the reserved `updatedAt` storage column, formatted via
 *  `row.updated_at`). MUST mirror `DATA_PREVIEW_SYSTEM_COLUMN_NAMES`
 *  server-side in `mountServerEndpoints.ts` (#443) — NAME-based only,
 *  these two well-known reserved names, no fuzzy matching. */
const DATA_PREVIEW_SYSTEM_COLUMN_NAMES = new Set(["updatedAt", "createdAt"]);

/** For `lifecycle: "operational"` collections: up to 3 data columns from the
 *  schema's `required` properties, skipping the schema-stable title
 *  field and the system-column-name collisions above (#443). MUST
 *  mirror `schemaTitleKey` / `adminDataPreview` server-side in
 *  `mountServerEndpoints.ts` — both sides derive from the schema alone
 *  so headers and cell values can never disagree. */
function dataPreviewColumns(collection: Collection | undefined): string[] {
  if (!collection || collection.lifecycle !== "operational") return [];
  const schema = collection.schema;
  const required = schema?.required ?? [];
  const titleKey = collectionTitleField(collection);
  return required
    .filter((key) => key !== titleKey && !DATA_PREVIEW_SYSTEM_COLUMN_NAMES.has(key))
    .slice(0, 3);
}

function collectionTitleField(collection: Collection | undefined): string | null {
  const schema = collection?.schema;
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  return (
    ["title", "name", "slug"].find((key) => key in properties) ??
    required.find((key) => {
      const raw = properties[key]?.type;
      const types = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return types.includes("string");
    }) ??
    null
  );
}
