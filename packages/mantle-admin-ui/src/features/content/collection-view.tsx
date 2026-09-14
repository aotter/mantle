import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  Download,
  Eye,
  FileText,
  Globe,
  PencilLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { api, downloadAdminFile } from "../../lib/api";
import { fieldLabel, propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { operationsQueryOptions } from "../../lib/queries";
import type {
  AdminUser,
  Collection,
  EntryEditorPayload,
  EntryRow,
  ListEntriesResult,
  SiteInfo,
  StaffOperation,
} from "../../lib/types";
import { PUBLISHING_STATUSES } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
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
import {
  boundOperationsFor,
  CollectionOperations,
  collectionOperationsFor,
  RowOperationsMenu,
} from "./row-operations";
import { renderDataValue } from "../../lib/render-data-value";
import { renderTitleText } from "../../lib/entry-title";
import { LocaleBadge, LocaleStatusBadges } from "./locale-badge";
import { ListQueryToolbar } from "../../ui/list-query-toolbar";
import { entryEditPath, entryLandingPath, hasFoldedChildCollections } from "../../lib/collection-nav";

const COLLECTION_PAGE_SIZE = 50;
type SortDirection = "asc" | "desc";

export function CollectionView({
  collectionName,
  scope,
  layout = "page",
  pathBase,
  extraParams,
}: {
  collectionName: string;
  scope?: { field: string; value: string };
  layout?: "page" | "panel";
  pathBase?: string;
  extraParams?: Record<string, string>;
}): React.ReactElement {
  const { language } = usePreferences();
  const { navigate } = useAdminRouter();
  const location = useAdminLocation();
  const queryClient = useQueryClient();
  const exportFile = useMutation({ mutationFn: downloadAdminFile });
  const params = new URLSearchParams(location.search);
  const status = params.get("status") ?? undefined;
  const searchTerm = params.get("search")?.trim() ?? "";
  const filterField = params.get("filter_field") ?? undefined;
  const filterValue = params.get("filter_value") ?? undefined;
  const parentQuery = params.get("parent") ?? undefined;
  const sortField = params.get("sort") || "updatedAt";
  const sortDirection: SortDirection = params.get("direction") === "asc" ? "asc" : "desc";
  const cursor = params.get("cursor") || undefined;
  const cursorDirection = params.get("cursor_direction") === "backward" ? "backward" : "forward";

  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const collection = collectionsQuery.data?.find((c) => c.name === collectionName);
  const appliesParentQuery = collection === undefined || collection.nav?.standalone === true;
  const parentFilter = scope?.value ?? (appliesParentQuery ? parentQuery : undefined);
  const resolvedScopeField = scope?.field ?? (parentFilter ? collection?.nav?.parentField : undefined);
  const resolvedScopeValue = scope?.value ?? parentFilter;
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });
  const canonical = site.data?.canonicalLocale ?? null;
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
  const boundOperations = React.useMemo(
    () => boundOperationsFor(operationsQuery.data, collectionName),
    [operationsQuery.data, collectionName],
  );
  const collectionOperations = React.useMemo(
    () => collectionOperationsFor(operationsQuery.data, collectionName),
    [operationsQuery.data, collectionName],
  );
  const entries = useQuery<ListEntriesResult>({
    queryKey: [
      "entries",
      collectionName,
      status ?? "all",
      searchTerm,
      filterField ?? "no-filter",
      filterValue ?? "no-value",
      resolvedScopeField ?? "no-scope-field",
      resolvedScopeValue ?? "no-scope-value",
      sortField,
      sortDirection,
      cursor ?? "first",
      cursorDirection,
    ],
    enabled: !parentFilter || Boolean(resolvedScopeField) || Boolean(scope),
    queryFn: () => {
      const qs = new URLSearchParams({
        collection: collectionName,
        limit: String(COLLECTION_PAGE_SIZE),
        sort: sortField,
        direction: sortDirection,
      });
      if (status) qs.set("status", status);
      if (searchTerm) qs.set("search", searchTerm);
      if (filterField && filterValue) {
        qs.set("filter_field", filterField);
        qs.set("filter_value", filterValue);
      }
      if (resolvedScopeField && resolvedScopeValue) {
        qs.set("scope_field", resolvedScopeField);
        qs.set("scope_value", resolvedScopeValue);
      }
      if (cursor) qs.set("cursor", cursor);
      if (cursorDirection === "backward") qs.set("cursor_direction", "backward");
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
    },
  });
  const [visibleEntries, setVisibleEntries] = React.useState<ListEntriesResult | null>(null);
  React.useEffect(() => {
    if (entries.data) setVisibleEntries(entries.data);
  }, [entries.data]);
  const displayedEntries = entries.data ?? visibleEntries;
  const isFirstLoad = entries.isLoading && !displayedEntries;

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  const heading = collection
    ? resolveLocalizedText(collection.title, language, canonical) ?? collection.name
    : collectionName;
  const isOperationalCollection = collection?.lifecycle === "operational";
  const isReadOnlyCollection = collection?.schema?.readOnly === true;
  const canManageContent = me.data?.role === "owner" || me.data?.role === "editor";
  const canCreateDraft = Boolean(me.data?.role) && !isOperationalCollection && !isReadOnlyCollection;
  const showSelection = canManageContent && !isReadOnlyCollection;
  const dataColumns = isOperationalCollection ? collection?.list?.columns ?? [] : [];
  const collectionFilter = isOperationalCollection ? collection?.filter ?? null : null;
  const listPath = pathBase ?? `/admin/c/${encodeURIComponent(collectionName)}`;
  const listState = {
    status,
    searchTerm,
    filterField,
    filterValue,
    sortField,
    sortDirection,
    parent: scope ? undefined : parentFilter,
    extraParams,
  };
  const listHref = (state: Parameters<typeof collectionHref>[1] = {}) =>
    collectionHref(listPath, { ...listState, ...state });
  const listQueryFilter = collectionFilter ? {
    name: collectionFilter.field,
    label: propertyLabel(
      collectionFilter.field,
      collection?.schema?.properties?.[collectionFilter.field],
      language,
      canonical,
    ),
    value: filterField === collectionFilter.field ? filterValue : "",
    allHref: listHref({ searchTerm, sortField, sortDirection, filterField: undefined, filterValue: undefined }),
    options: collectionFilter.values.map((value) => ({
      value,
      label: fieldLabel(value),
      href: listHref({
        searchTerm,
        filterField: collectionFilter.field,
        filterValue: value,
        sortField,
        sortDirection,
      }),
    })),
  } : collection && !isOperationalCollection ? {
    name: "status",
    label: t(language, "collection.table.status"),
    value: status,
    allHref: listHref({ searchTerm, sortField, sortDirection, status: undefined }),
    options: PUBLISHING_STATUSES.map((value) => ({
      value,
      label: statusLabel(language, value),
      href: listHref({
        status: value,
        searchTerm,
        sortField,
        sortDirection,
      }),
    })),
  } : null;
  const titleField = isOperationalCollection
    ? collection?.list?.primaryField ?? null
    : null;
  const titleColumnLabel = titleField
    ? propertyLabel(titleField, collection?.schema?.properties?.[titleField], language, canonical)
    : t(language, "collection.table.title");
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
      api.post<EntryEditorPayload>("/entries", {
        collection: collectionName,
        data: resolvedScopeField && resolvedScopeValue
          ? { [resolvedScopeField]: resolvedScopeValue }
          : {},
      }),
    onSuccess: (payload) => {
      const path = hasFoldedChildCollections(collectionsQuery.data ?? [], collectionName)
        ? entryEditPath(collectionName, payload.entry.id)
        : entryLandingPath(collectionName, payload.entry.id);
      navigate(path);
    },
  });

  const header = (
    <PageHeader
      eyebrow={layout === "page" ? (
        <>
          <a href="/admin" className="hover:underline">
            {t(language, "collection.breadcrumb")}
          </a>
          <span className="mx-2 text-foreground/30">/</span>
          <span className="text-foreground/70">{heading}</span>
        </>
      ) : undefined}
      title={heading}
      description={renderCollectionDescription(collection, language, canonical)}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const exportParams = new URLSearchParams({ collection: collectionName });
                if (status) exportParams.set("status", status);
                if (searchTerm) exportParams.set("search", searchTerm);
                if (filterField && filterValue) {
                  exportParams.set("filter_field", filterField);
                  exportParams.set("filter_value", filterValue);
                }
                if (resolvedScopeField && resolvedScopeValue) {
                  exportParams.set("scope_field", resolvedScopeField);
                  exportParams.set("scope_value", resolvedScopeValue);
                }
                exportParams.set("sort", sortField);
                exportParams.set("direction", sortDirection);
                exportFile.mutate(`/admin/api/entries/export?${exportParams.toString()}`);
              }}
              disabled={exportFile.isPending}
            >
              <Download className="size-4" aria-hidden />
              {t(language, "collection.export")}
            </Button>
            {collection && canCreateDraft ? (
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
            <CollectionOperations
              operations={collectionOperations}
              language={language}
              canonical={canonical}
              onSuccess={refreshEntries}
            />
          </div>
        }
      />
  );

  return (
    <div>
      {header}
      {createMutation.isError ? <ErrorBox error={createMutation.error} /> : null}
      {exportFile.isError ? <ErrorBox error={exportFile.error} /> : null}

      {collection?.nav?.standalone && !scope ? (
        <ParentScopeFilter
          collection={collection}
          selectedId={parentFilter}
          language={language}
          canonical={canonical}
          onSelect={(id) => navigate(listHref({ parent: id, cursor: undefined, cursorDirection: undefined }))}
        />
      ) : null}

      {collection ? (
        <ListQueryToolbar
          key={location.search}
          language={language}
          searchValue={searchTerm}
          filters={listQueryFilter ? [listQueryFilter] : []}
          onSubmit={({ search, filters }) => {
            const nextFilter = collectionFilter ? filters[collectionFilter.field] : undefined;
            navigate(listHref({
              status: isOperationalCollection ? status : filters.status || undefined,
              searchTerm: search,
              filterField: nextFilter ? collectionFilter?.field : undefined,
              filterValue: nextFilter || undefined,
              sortField,
              sortDirection,
            }));
          }}
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
              : filterValue
              ? t(language, "collection.empty.withStatus", {
                  collection: heading,
                  status: fieldLabel(filterValue),
                })
              : status
              ? t(language, "collection.empty.withStatus", { collection: heading, status })
              : t(language, "collection.empty.all", { collection: heading })
          }
        />
      )}
      {displayedEntries && displayedEntries.items.length > 0 && (
        <>
          {selected.size > 0 && canManageContent && !isReadOnlyCollection ? (
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
                {showSelection ? (
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
                ) : null}
                <SortableTableHead
                  className="hidden md:table-cell"
                  label={t(language, "collection.table.id")}
                  field="id"
                  activeField={sortField}
                  direction={sortDirection}
                  href={sortHref(listPath, listState, "id", sortField, sortDirection)}
                />
                {!isOperationalCollection || titleField ? (
                  titleField && collection?.sortableFields?.includes(titleField)
                    ? <SortableTableHead
                        label={titleColumnLabel}
                        field={titleField}
                        activeField={sortField}
                        direction={sortDirection}
                        href={sortHref(listPath, listState, titleField, sortField, sortDirection)}
                      />
                    : <TableHead>{titleColumnLabel}</TableHead>
                ) : null}
                {isOperationalCollection ? (
                  dataColumns.map((name) => (
                    collection?.sortableFields?.includes(name)
                      ? <SortableTableHead
                          key={name}
                          label={propertyLabel(name, collection?.schema?.properties?.[name], language, canonical)}
                          field={name}
                          activeField={sortField}
                          direction={sortDirection}
                          href={sortHref(listPath, listState, name, sortField, sortDirection)}
                        />
                      : <TableHead key={name}>
                          {propertyLabel(name, collection?.schema?.properties?.[name], language, canonical)}
                        </TableHead>
                  ))
                ) : (
                  <>
                    <SortableTableHead
                      className="hidden md:table-cell"
                      label={t(language, "collection.table.status")}
                      field="status"
                      activeField={sortField}
                      direction={sortDirection}
                      href={sortHref(listPath, listState, "status", sortField, sortDirection)}
                    />
                    {collection && (collection.localized || collection.hasTranslations) ? (
                      <TableHead>
                        <span className="inline-flex items-center gap-1.5">
                          <Globe className="size-3.5" aria-hidden />
                          {t(language, "collection.table.locale")}
                        </span>
                      </TableHead>
                    ) : null}
                    <TableHead className="hidden md:table-cell">{t(language, "collection.table.version")}</TableHead>
                  </>
                )}
                <SortableTableHead
                  className="hidden md:table-cell"
                  label={t(language, "collection.table.updated")}
                  field="updatedAt"
                  activeField={sortField}
                  direction={sortDirection}
                  href={sortHref(listPath, listState, "updatedAt", sortField, sortDirection)}
                />
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
                  siteLocales={site.data?.locales ?? []}
                  dataColumns={isOperationalCollection ? dataColumns : null}
                  primaryField={isOperationalCollection ? titleField : null}
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
                  canEdit={
                    !isReadOnlyCollection && (canManageContent ||
                      (me.data?.role === "contributor" &&
                        !isOperationalCollection &&
                        row.status === "draft"))
                  }
                  canDelete={canManageContent && !isReadOnlyCollection}
                />
              ))}
            </TableBody>
          </Table>
          {entries.isFetching && !entries.data ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t(language, "collection.refreshing")}
            </p>
          ) : null}
          <CollectionPagination
            previousHref={displayedEntries.previous_cursor ? listHref({
              cursor: displayedEntries.previous_cursor,
              cursorDirection: "backward",
            }) : undefined}
            nextHref={displayedEntries.next_cursor ? listHref({
              cursor: displayedEntries.next_cursor,
              cursorDirection: "forward",
            }) : undefined}
            language={language}
          />
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

/** Pick the collection summary from its lifecycle and translation support. */
export function collectionSummaryKey(collection: Collection | undefined): I18nKey {
  const hasLifecycle = collection ? collection.lifecycle !== "operational" : true;
  const hasTranslations = collection ? collection.localized || collection.hasTranslations : false;
  if (hasLifecycle && hasTranslations) return "collection.schemaSummary.lifecycleAndI18n";
  if (hasLifecycle) return "collection.schemaSummary.lifecycleOnly";
  if (hasTranslations) return "collection.schemaSummary.i18nOnly";
  return "collection.schemaSummary.plain";
}

function collectionHref(
  path: string,
  state: {
    status?: string;
    searchTerm?: string;
    filterField?: string;
    filterValue?: string;
    sortField?: string;
    sortDirection?: SortDirection;
    cursor?: string;
    cursorDirection?: "forward" | "backward";
    parent?: string;
    extraParams?: Record<string, string>;
  } = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.extraParams ?? {})) {
    if (value) params.set(key, value);
  }
  if (state.status) params.set("status", state.status);
  if (state.searchTerm) params.set("search", state.searchTerm);
  if (state.filterField && state.filterValue) {
    params.set("filter_field", state.filterField);
    params.set("filter_value", state.filterValue);
  }
  if (state.parent) params.set("parent", state.parent);
  if (state.sortField && state.sortField !== "updatedAt") params.set("sort", state.sortField);
  if (state.sortDirection && state.sortDirection !== "desc") {
    params.set("direction", state.sortDirection);
  }
  if (state.cursor) params.set("cursor", state.cursor);
  if (state.cursorDirection === "backward") params.set("cursor_direction", "backward");
  const suffix = params.toString();
  return `${path}${suffix ? `?${suffix}` : ""}`;
}

function sortHref(
  path: string,
  state: Parameters<typeof collectionHref>[1],
  field: string,
  activeField: string,
  direction: SortDirection,
): string {
  return collectionHref(path, {
    ...state,
    cursor: undefined,
    cursorDirection: undefined,
    sortField: field,
    sortDirection: activeField === field
      ? (direction === "asc" ? "desc" : "asc")
      : (field === "updatedAt" ? "desc" : "asc"),
  });
}

function SortableTableHead({
  className,
  label,
  field,
  activeField,
  direction,
  href,
}: {
  className?: string;
  label: React.ReactNode;
  field: string;
  activeField: string;
  direction: SortDirection;
  href: string;
}): React.ReactElement {
  const Icon = activeField !== field ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <a href={href} className="inline-flex items-center gap-1.5 font-medium hover:text-foreground">
        {label}
        <Icon className={cn("size-3.5", activeField === field ? "opacity-100" : "opacity-35")} aria-hidden />
      </a>
    </TableHead>
  );
}

function CollectionPagination({
  previousHref,
  nextHref,
  language,
}: {
  previousHref?: string;
  nextHref?: string;
  language: AdminLanguage;
}): React.ReactElement | null {
  if (!previousHref && !nextHref) return null;
  return (
    <Pagination className="mt-4 justify-end" aria-label={t(language, "collection.pagination")}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={previousHref}
            text={t(language, "collection.previousPage")}
            aria-label={t(language, "collection.previousPage")}
            aria-disabled={!previousHref || undefined}
            tabIndex={previousHref ? undefined : -1}
            className={cn(!previousHref && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href={nextHref}
            text={t(language, "collection.nextPage")}
            aria-label={t(language, "collection.nextPage")}
            aria-disabled={!nextHref || undefined}
            tabIndex={nextHref ? undefined : -1}
            className={cn(!nextHref && "pointer-events-none opacity-50")}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function ParentScopeFilter({
  collection,
  selectedId,
  language,
  canonical,
  onSelect,
}: {
  collection: Collection;
  selectedId: string | undefined;
  language: AdminLanguage;
  canonical: string | null;
  onSelect: (id: string | undefined) => void;
}): React.ReactElement {
  const parentName = collection.nav?.parentCollection;
  const parentField = collection.nav?.parentField ?? "parent";
  const [term, setTerm] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const parentCollection = collectionsQuery.data?.find((item) => item.name === parentName);
  const parentLabel = parentCollection
    ? resolveLocalizedText(parentCollection.title, language, canonical) ?? parentCollection.name
    : parentName ?? parentField;
  const selected = useQuery<EntryEditorPayload>({
    queryKey: ["entry-editor", selectedId],
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(selectedId!)}`),
    enabled: Boolean(selectedId),
  });
  const options = useQuery<ListEntriesResult>({
    queryKey: ["parent-scope-options", parentName, term],
    queryFn: () => {
      const qs = new URLSearchParams({
        collection: parentName!,
        limit: "20",
        sort: "updatedAt",
        direction: "desc",
      });
      if (term.trim()) qs.set("search", term.trim());
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
    },
    enabled: Boolean(parentName) && open,
  });
  const selectedTitle = selected.data
    ? renderTitleText(selected.data.entry.data.title ?? selected.data.entry.data.name ?? selected.data.entry.id, language)
    : selectedId;
  return (
    <div className="mb-4 max-w-xl space-y-2">
      <label className="text-sm font-medium" htmlFor={`parent-filter-${collection.name}`}>
        {t(language, "collection.parentFilter", { name: parentLabel })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {selectedId ? (
          <span className="inline-flex items-center gap-1 rounded-lg border bg-secondary px-2 py-1 text-sm">
            <span className="max-w-56 truncate">{selectedTitle}</span>
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-accent"
              aria-label={t(language, "collection.parentFilterClear")}
              onClick={() => onSelect(undefined)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : null}
        <Input
          id={`parent-filter-${collection.name}`}
          className="h-9 max-w-xs"
          value={term}
          placeholder={t(language, "collection.parentFilterPlaceholder", { name: parentLabel })}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
        />
      </div>
      {open && options.data ? (
        <ul className="max-h-56 overflow-y-auto rounded-lg border bg-card text-sm shadow-sm">
          {options.data.items.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">{t(language, "collection.empty.title")}</li>
          ) : options.data.items.map((row) => {
            const label = renderTitleText(
              row.title ?? (parentCollection?.list?.primaryField
                ? row.data_preview?.[parentCollection.list.primaryField]
                : row.id),
              language,
            );
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    onSelect(row.id);
                    setTerm("");
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{label || row.id}</span>
                  <span className="font-mono text-xs text-muted-foreground">{idTail(row.id)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
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

/** Show a short id suffix while copy and tooltip retain the full value. */
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
  siteLocales,
  dataColumns,
  primaryField,
  boundOperations,
  onOperationSuccess,
  selected,
  onToggleSelect,
  onRename,
  onDelete,
  busy,
  canEdit,
  canDelete,
}: {
  row: EntryRow;
  language: AdminLanguage;
  canonical: string | null;
  collection: Collection | undefined;
  siteLocales: readonly string[];
  /** Non-null (possibly empty) for `lifecycle: "operational"` collections —
   *  swaps the status/locale/version cells for these data columns. */
  dataColumns: string[] | null;
  primaryField: string | null;
  /** Operations bound to this collection's rows. */
  boundOperations: StaffOperation[];
  onOperationSuccess: () => void;
  selected: boolean;
  onToggleSelect: (checked: boolean) => void;
  onRename: (title: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  busy: boolean;
  canEdit: boolean;
  canDelete: boolean;
}): React.ReactElement {
  const isOperational = dataColumns !== null;
  const itemName = renderTitleText(
    isOperational ? (primaryField ? row.data_preview?.[primaryField] : row.id) : row.title,
    language,
  );
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
      {canDelete ? (
        <TableCell>
          <Checkbox
            aria-label={t(language, "collection.table.selectRow", { name: itemName })}
            checked={selected}
            onCheckedChange={(checked) => onToggleSelect(checked === true)}
          />
        </TableCell>
      ) : null}
      <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
        <CopyIdButton id={String(row.id)} language={language} />
      </TableCell>
      {!isOperational || primaryField ? <TableCell className="max-w-[28rem]">
        <div className="min-w-44 md:min-w-64">
          {isOperational ? (
            <a
              href={entryLandingPath(row.collection, row.id)}
              className="block truncate font-medium hover:underline"
              title={itemName}
            >
              {renderDataValue(collection?.schema?.properties?.[primaryField ?? ""], row.data_preview?.[primaryField ?? ""])}
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
          ) : canEdit ? (
            <button
              type="button"
              className="group inline-flex max-w-full items-center gap-2 text-left"
              onClick={() => setEditing(true)}
              title={itemName}
            >
              <span className="truncate">{renderTitle(row.title, language)}</span>
              <PencilLine className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
            </button>
          ) : (
            <a
              href={entryLandingPath(row.collection, row.id)}
              className="block truncate font-medium hover:underline"
              title={itemName}
            >
              {renderTitle(row.title, language)}
            </a>
          )}
          {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
        </div>
      </TableCell> : null}
      {dataColumns ? (
        dataColumns.map((name) => (
          <TableCell key={name} className="text-muted-foreground">
            {renderDataValue(collection?.schema?.properties?.[name], row.data_preview?.[name])}
          </TableCell>
        ))
      ) : (
        <>
          <TableCell className="hidden md:table-cell">
            <StatusBadge status={row.status} />
          </TableCell>
          {collection && (collection.localized || collection.hasTranslations) ? (
            <TableCell>
              {collection.hasTranslations ? (
                <LocaleStatusBadges
                  locales={siteLocales}
                  available={row.translation_locales}
                  language={language}
                />
              ) : <LocaleBadge locale={row.locale} />}
            </TableCell>
          ) : null}
          <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
            v{row.version}
          </TableCell>
        </>
      )}
      <TableCell className="hidden text-muted-foreground md:table-cell">
        {formatTimestampMs(row.updated_at) ?? "-"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          {canEdit ? (
            <Button asChild variant="ghost" size="icon-sm">
              <a
                title={t(language, "crud.editTooltip", { name: itemName })}
                aria-label={t(language, "crud.editTooltip", { name: itemName })}
                href={entryEditPath(row.collection, row.id)}
              >
                <PencilLine className="size-3.5" aria-hidden />
              </a>
            </Button>
          ) : (
            <Button asChild variant="ghost" size="icon-sm">
              <a
                title={t(language, "crud.viewTooltip", { name: itemName })}
                aria-label={t(language, "crud.viewTooltip", { name: itemName })}
                href={entryLandingPath(row.collection, row.id)}
              >
                <Eye className="size-3.5" aria-hidden />
              </a>
            </Button>
          )}
          {canDelete ? (
            <Button type="button" variant="ghost" size="icon-sm" title={t(language, "crud.deleteTooltip", { name: itemName })} disabled={busy} onClick={() => void remove()}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          ) : null}
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
