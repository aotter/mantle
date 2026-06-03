import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, Copy, FileText, PencilLine, Plus, RotateCcw, Send, Trash2, X } from "lucide-react";
import { useAdminLocation } from "../../app/router";
import { api } from "../../lib/api";
import type { Collection, EntryRow, ListEntriesResult } from "../../lib/types";
import { TableCell, TableHeadCell, TableShell } from "../../ui/admin-table";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader } from "../../ui/page";
import { ResourceFilterBar, ResourceFilterLink, ResourceListSkeleton, ResourceSearchField, ResourceToolbar } from "../../ui/resource";
import { StatusBadge } from "../../ui/status-badge";
import { statusLabel } from "./status";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { collectionDescription, collectionTitle } from "./collection-labels";

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
  const cursor = params.get("cursor") ?? undefined;
  const cursorOffset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;

  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const entries = useQuery<ListEntriesResult>({
    queryKey: ["entries", collectionName, status ?? "all", language, cursor ?? "0"],
    queryFn: () => {
      const qs = new URLSearchParams({
        collection: collectionName,
        limit: "30",
        locale: language,
      });
      if (status) qs.set("status", status);
      if (cursor) qs.set("cursor", cursor);
      return api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
    },
  });
  const [visibleEntries, setVisibleEntries] = React.useState<ListEntriesResult | null>(null);
  React.useEffect(() => {
    if (entries.data) setVisibleEntries(entries.data);
  }, [entries.data]);
  const displayedEntries = entries.data ?? visibleEntries;
  const filteredEntries = React.useMemo(() => {
    if (!displayedEntries || !searchTerm) return displayedEntries;
    const needle = searchTerm.toLocaleLowerCase();
    return {
      ...displayedEntries,
      items: displayedEntries.items.filter((row) => {
        const title = renderTitleText(row.title, language);
        return [
          row.id,
          row.collection,
          row.status,
          row.locale ?? "",
          title,
        ].some((value) => String(value).toLocaleLowerCase().includes(needle));
      }),
    };
  }, [displayedEntries, language, searchTerm]);
  const isFirstLoad = entries.isLoading && !displayedEntries;

  const collection = collectionsQuery.data?.find((c) => c.name === collectionName);
  const heading = collection ? collectionTitle(collection, language) : collectionName;
  const refreshEntries = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["entries", collectionName] });
  }, [collectionName, queryClient]);

  const titleMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<EntryRow>(`/entries/${encodeURIComponent(id)}`, {
        title,
        locale: language,
      }),
    onSuccess: refreshEntries,
  });
  const duplicateMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<EntryRow>(`/entries/${encodeURIComponent(id)}/duplicate`, {
        locale: language,
      }),
    onSuccess: refreshEntries,
  });
  const createMutation = useMutation({
    mutationFn: () =>
      api.post<EntryRow>("/entries", {
        collection: collectionName,
        locale: language,
      }),
    onSuccess: (row) => {
      window.location.href = `/admin/c/${encodeURIComponent(row.collection)}/${encodeURIComponent(row.id)}`;
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ removed: boolean }>(`/entries/${encodeURIComponent(id)}`),
    onSuccess: refreshEntries,
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, nextStatus }: { id: string; nextStatus: "draft" | "published" | "archived" }) =>
      api.post<EntryRow>(`/entries/${encodeURIComponent(id)}/status`, {
        status: nextStatus,
        locale: language,
      }),
    onSuccess: refreshEntries,
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
        description={renderCollectionDescription(collection, language)}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {collection ? (
              <Button
                type="button"
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
                title={t(language, "crud.createTooltip", { name: heading })}
              >
                <Plus className="size-3.5" aria-hidden />
                {createMutation.isPending ? t(language, "crud.saving") : t(language, "crud.create")}
              </Button>
            ) : null}
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

      {collection ? (
        <StatusFilter
          collection={collection}
          activeStatus={status}
          searchTerm={searchTerm}
          language={language}
        />
      ) : null}

      {isFirstLoad && <EntriesSkeleton />}
      {entries.isError && !displayedEntries && <ErrorBox error={entries.error} />}
      {filteredEntries && filteredEntries.items.length === 0 && (
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
      {filteredEntries && filteredEntries.items.length > 0 && (
        <>
          <TableShell>
            <thead>
              <tr className="border-b border-[var(--glass-border)]">
                <TableHeadCell>{t(language, "collection.table.id")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.title")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.status")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.locale")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.version")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.updated")}</TableHeadCell>
                <TableHeadCell>{t(language, "collection.table.actions")}</TableHeadCell>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.items.map((row) => (
                <EntryRowDisplay
                  key={row.id}
                  row={row}
                  language={language}
                  collection={collection}
                  onRename={(title) => titleMutation.mutateAsync({ id: row.id, title })}
                  onDuplicate={() => duplicateMutation.mutateAsync(row.id)}
                  onDelete={() => deleteMutation.mutateAsync(row.id)}
                  onStatusChange={(nextStatus) => statusMutation.mutateAsync({ id: row.id, nextStatus })}
                  busy={
                    (titleMutation.isPending && titleMutation.variables?.id === row.id) ||
                    (duplicateMutation.isPending && duplicateMutation.variables === row.id) ||
                    (deleteMutation.isPending && deleteMutation.variables === row.id) ||
                    (statusMutation.isPending && statusMutation.variables?.id === row.id)
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
          <CursorPagination
            collectionName={collectionName}
            status={status}
            searchTerm={searchTerm}
            cursorOffset={cursorOffset}
            nextCursor={filteredEntries.next_cursor}
            language={language}
          />
        </>
      )}
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
    <ResourceToolbar className="max-w-3xl">
      <ResourceSearchField
        value={draft}
        onChange={setDraft}
        placeholder={t(language, "collection.searchPlaceholder")}
        onSubmit={() => {
          const next = draft.trim();
          const params = new URLSearchParams();
          if (status) params.set("status", status);
          if (next) params.set("search", next);
          const suffix = params.toString();
          window.location.href = `/admin/c/${encodeURIComponent(collectionName)}${suffix ? `?${suffix}` : ""}`;
        }}
      />
    </ResourceToolbar>
  );
}

function renderCollectionDescription(
  collection: Collection | undefined,
  language: AdminLanguage,
): React.ReactNode {
  const raw = collectionDescription(collection, language)?.trim();
  if (!raw) return t(language, "collection.defaultDescription");

  if (!looksLikeSchemaNotes(raw)) return raw;

  return (
    <div className="space-y-2">
      <p>
        {t(language, "collection.schemaSummary", {
          name: collection ? collectionTitle(collection, language) : "",
        })}
      </p>
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-border bg-card/70 px-2.5 py-1 text-xs font-semibold text-foreground/70 transition hover:bg-accent hover:text-accent-foreground">
          {t(language, "collection.schemaDetails")}
        </summary>
        <p className="mt-2 max-w-3xl rounded-md border border-border bg-card/55 p-3 text-xs leading-relaxed text-muted-foreground">
          {raw}
        </p>
      </details>
    </div>
  );
}

function looksLikeSchemaNotes(description: string): boolean {
  return (
    description.length > 180 ||
    /`|SKU|BCP|ISO|ContentState|column|field|schema|locale|inventory/i.test(description)
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
    <ResourceFilterBar>
      <ResourceFilterLink
        href={collectionFilterHref(collection.name, undefined, searchTerm)}
        active={!activeStatus}
      >
        {t(language, "collection.filter.all")}
      </ResourceFilterLink>
      {statuses.map((s) => (
        <ResourceFilterLink
          key={s}
          href={collectionFilterHref(collection.name, s, searchTerm)}
          active={activeStatus === s}
        >
          {statusLabel(language, s)}
        </ResourceFilterLink>
      ))}
    </ResourceFilterBar>
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

function EntriesSkeleton(): React.ReactElement {
  return <ResourceListSkeleton />;
}

function EntryRowDisplay({
  row,
  language,
  collection,
  onRename,
  onDuplicate,
  onDelete,
  onStatusChange,
  busy,
}: {
  row: EntryRow;
  language: AdminLanguage;
  collection: Collection | undefined;
  onRename: (title: string) => Promise<unknown>;
  onDuplicate: () => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onStatusChange: (status: "draft" | "published" | "archived") => Promise<unknown>;
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

  async function duplicate(): Promise<void> {
    setError(null);
    try {
      await onDuplicate();
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

  async function changeStatus(nextStatus: "draft" | "published" | "archived"): Promise<void> {
    setError(null);
    try {
      await onStatusChange(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <tr className="border-t border-[var(--glass-border)] hover:bg-accent/40">
      <TableCell className="font-mono text-xs text-muted-foreground">
        {String(row.id).slice(0, 8)}
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
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell className="text-muted-foreground">{row.locale ?? "-"}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        v{row.version}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatTimestamp(row.updated_at)}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1" data-tour="entry-actions">
          {row.status !== "published" ? (
            <button type="button" className="row-action" title={t(language, "crud.publishTooltip", { name: itemName })} disabled={busy} onClick={() => void changeStatus("published")}>
              <Send className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {row.status !== "draft" ? (
            <button type="button" className="row-action" title={t(language, "crud.draftTooltip", { name: itemName })} disabled={busy} onClick={() => void changeStatus("draft")}>
              <RotateCcw className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {row.status !== "archived" ? (
            <button type="button" className="row-action" title={t(language, "crud.archiveTooltip", { name: itemName })} disabled={busy} onClick={() => void changeStatus("archived")}>
              <Archive className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <a className="row-action" title={t(language, "crud.editTooltip", { name: itemName })} href={`/admin/c/${encodeURIComponent(row.collection)}/${encodeURIComponent(row.id)}`}>
            <PencilLine className="size-3.5" aria-hidden />
          </a>
          <button type="button" className="row-action" title={t(language, "crud.duplicateTooltip", { name: itemName })} disabled={busy} onClick={() => void duplicate()}>
            <Copy className="size-3.5" aria-hidden />
          </button>
          <button type="button" className="row-action" title={t(language, "crud.deleteTooltip", { name: itemName })} disabled={busy} onClick={() => void remove()}>
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
        <span className="sr-only">{collection ? collectionTitle(collection, language) : ""}</span>
      </TableCell>
    </tr>
  );
}

function CursorPagination({
  collectionName,
  status,
  searchTerm,
  cursorOffset,
  nextCursor,
  language,
}: {
  collectionName: string;
  status: string | undefined;
  searchTerm: string;
  cursorOffset: number;
  nextCursor: string | null;
  language: AdminLanguage;
}): React.ReactElement | null {
  if (cursorOffset === 0 && !nextCursor) return null;
  const previousCursor = Math.max(0, cursorOffset - 30);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>
        {t(language, "collection.cursorRange", {
          start: String(cursorOffset + 1),
          end: String(cursorOffset + 30),
        })}
      </span>
      <div className="flex items-center gap-2">
        <a
          className="row-action h-9 min-w-24 px-3"
          aria-disabled={cursorOffset === 0}
          href={cursorOffset === 0 ? undefined : collectionPageHref(collectionName, status, searchTerm, previousCursor === 0 ? undefined : String(previousCursor))}
        >
          {t(language, "resource.previousPage")}
        </a>
        <a
          className="row-action h-9 min-w-24 px-3"
          aria-disabled={!nextCursor}
          href={nextCursor ? collectionPageHref(collectionName, status, searchTerm, nextCursor) : undefined}
        >
          {t(language, "resource.nextPage")}
        </a>
      </div>
    </div>
  );
}

function collectionPageHref(
  collectionName: string,
  status: string | undefined,
  searchTerm: string,
  cursor: string | undefined,
): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (searchTerm) params.set("search", searchTerm);
  if (cursor) params.set("cursor", cursor);
  const suffix = params.toString();
  return `/admin/c/${encodeURIComponent(collectionName)}${suffix ? `?${suffix}` : ""}`;
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
