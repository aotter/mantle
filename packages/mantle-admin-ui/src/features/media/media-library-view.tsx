import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  Check,
  Copy,
  ImagePlus,
  LayoutGrid,
  List,
  Tags,
  Trash2,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { AdminMediaAsset, ListMediaAssetsResult } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { ResourceSearchField } from "../../ui/resource";

type MediaSort = "newest" | "name" | "type";
type MediaViewMode = "grid" | "list";

const MEDIA_PAGE_SIZES = [10, 30, 50, 100] as const;

interface MediaUploadResponse {
  uploadGroupId: string;
  capabilities: Array<{
    mimeType: string;
    role: string;
    method: "PUT";
    uploadUrl: string;
    requiredHeaders?: Record<string, string>;
  }>;
}

export function MediaLibraryView(): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = React.useState("");
  const [submittedQuery, setSubmittedQuery] = React.useState("");
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = React.useState<Array<string | null>>([]);
  const [sort, setSort] = React.useState<MediaSort>("newest");
  const [viewMode, setViewMode] = React.useState<MediaViewMode>("grid");
  const [pageSize, setPageSize] = React.useState<(typeof MEDIA_PAGE_SIZES)[number]>(30);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [copied, setCopied] = React.useState<string | null>(null);

  const assets = useQuery<ListMediaAssetsResult>({
    queryKey: ["media-assets", submittedQuery, cursor ?? "0", pageSize],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (submittedQuery) params.set("search", submittedQuery);
      if (cursor) params.set("cursor", cursor);
      return api.get<ListMediaAssetsResult>(`/media/assets?${params.toString()}`);
    },
  });

  const rows = React.useMemo(() => {
    const items = [...(assets.data?.items ?? [])];
    return items.sort((a, b) => {
      if (sort === "name") return assetLabel(a).localeCompare(assetLabel(b));
      if (sort === "type") return (a.primaryMimeType ?? "").localeCompare(b.primaryMimeType ?? "") || assetLabel(a).localeCompare(assetLabel(b));
      return b.createdAt - a.createdAt;
    });
  }, [assets.data?.items, sort]);

  const selectedAssets = React.useMemo(
    () => rows.filter((asset) => selectedIds.has(asset.id)),
    [rows, selectedIds],
  );
  const allVisibleSelected = rows.length > 0 && rows.every((asset) => selectedIds.has(asset.id));
  const rangeStart = rows.length === 0 ? 0 : cursorHistory.length * pageSize + 1;
  const rangeEnd = rows.length === 0 ? 0 : rangeStart + rows.length - 1;

  const resetPaging = React.useCallback(() => {
    setCursor(null);
    setCursorHistory([]);
    setSelectedIds(new Set());
  }, []);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const created = await api.post<MediaUploadResponse>("/media/uploads", {
        filename: file.name,
        purpose: "content",
        variants: [{ mimeType: file.type || "application/octet-stream", byteSize: file.size, role: "primary" }],
        alt: file.name.replace(/\.[^.]+$/, ""),
      });
      const capability = created.capabilities.find((cap) => cap.role === "primary") ?? created.capabilities[0];
      if (!capability) throw new Error("Upload capability missing.");
      await fetch(capability.uploadUrl, {
        method: capability.method,
        headers: capability.requiredHeaders ?? { "Content-Type": file.type },
        body: file,
      });
      return api.post<AdminMediaAsset>(
        `/media/uploads/${encodeURIComponent(created.uploadGroupId)}/commit`,
        { alt: file.name.replace(/\.[^.]+$/, "") },
      );
    },
    onSuccess: () => {
      setCursor(null);
      void queryClient.invalidateQueries({ queryKey: ["media-assets"] });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, alt, caption }: { id: string; alt: string; caption: string }) =>
      api.patch<AdminMediaAsset>(`/media/assets/${encodeURIComponent(id)}`, { alt, caption }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["media-assets"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ removed: boolean }>(`/media/assets/${encodeURIComponent(id)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["media-assets"] }),
  });

  const bulkRemove = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => api.delete<{ removed: boolean }>(`/media/assets/${encodeURIComponent(id)}`)));
      return ids;
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["media-assets"] });
    },
  });

  async function copyUrl(asset: AdminMediaAsset): Promise<void> {
    if (!asset.primaryUrl) return;
    try {
      const url = new URL(asset.primaryUrl, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setCopied(asset.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  async function copySelectedUrls(): Promise<void> {
    const urls = selectedAssets
      .map((asset) => asset.primaryUrl ? new URL(asset.primaryUrl, window.location.origin).toString() : null)
      .filter((url): url is string => Boolean(url));
    if (urls.length === 0) return;
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      setCopied("selected");
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  function toggleSelected(id: string, checked: boolean): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleVisible(checked: boolean): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      rows.forEach((asset) => {
        if (checked) next.add(asset.id);
        else next.delete(asset.id);
      });
      return next;
    });
  }

  function deleteSelected(): void {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (typeof window !== "undefined" && !window.confirm(t(language, "media.deleteSelectedConfirm", { count: String(ids.length) }))) {
      return;
    }
    bulkRemove.mutate(ids);
  }

  function goNextPage(): void {
    const nextCursor = assets.data?.next_cursor;
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, cursor]);
    setCursor(nextCursor);
    setSelectedIds(new Set());
  }

  function goPreviousPage(): void {
    setCursorHistory((prev) => {
      const next = [...prev];
      const previousCursor = next.pop() ?? null;
      setCursor(previousCursor);
      return next;
    });
    setSelectedIds(new Set());
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "media.page.title")}
        description={t(language, "media.page.body")}
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = "";
              }}
            />
            <Button type="button" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
              <ImagePlus className="size-4" aria-hidden />
              {upload.isPending ? t(language, "media.uploading") : t(language, "media.upload")}
            </Button>
          </>
        }
      />

      {upload.isError ? <ErrorBox error={upload.error} /> : null}
      {assets.isError ? <ErrorBox error={assets.error} /> : null}

      <SectionCard className="media-album">
        <div className="media-toolbar">
          <ResourceSearchField
            className="media-search"
            value={query}
            onChange={setQuery}
            placeholder={t(language, "media.search")}
            onSubmit={() => {
              resetPaging();
              setSubmittedQuery(query.trim());
            }}
          />
          <label className="media-sort" title={t(language, "media.sort")}>
            <ArrowDownUp className="size-4" aria-hidden />
            <select value={sort} onChange={(event) => setSort(event.target.value as MediaSort)}>
              <option value="newest">{t(language, "media.sort.newest")}</option>
              <option value="name">{t(language, "media.sort.name")}</option>
              <option value="type">{t(language, "media.sort.type")}</option>
            </select>
          </label>
          <div className="media-view-toggle" aria-label={t(language, "media.viewMode")}>
            <button
              type="button"
              className={viewMode === "grid" ? "is-active" : ""}
              title={t(language, "media.viewGrid")}
              aria-pressed={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
            >
              <LayoutGrid className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              className={viewMode === "list" ? "is-active" : ""}
              title={t(language, "media.viewList")}
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              <List className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="media-dropzone-compact w-full text-left"
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus className="size-5" aria-hidden />
          <strong>{t(language, "media.dropzone")}</strong>
          <span>{t(language, "media.dropzoneHint")}</span>
        </button>

        {assets.isLoading ? <div className="h-40 animate-pulse rounded-lg bg-muted/50" /> : null}

        {!assets.isLoading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(language, "media.empty")}</p>
        ) : null}

        {!assets.isLoading && rows.length > 0 ? (
          <>
            <MediaBulkToolbar
              language={language}
              selectedCount={selectedIds.size}
              allVisibleSelected={allVisibleSelected}
              copied={copied === "selected"}
              busy={bulkRemove.isPending || remove.isPending || update.isPending}
              onToggleVisible={toggleVisible}
              onClear={() => setSelectedIds(new Set())}
              onCopy={() => void copySelectedUrls()}
              onDelete={deleteSelected}
            />
            {viewMode === "grid" ? (
              <div className="media-grid album-grid">
                {rows.map((asset) => (
                  <MediaAssetCard
                    key={asset.id}
                    asset={asset}
                    selected={selectedIds.has(asset.id)}
                    copied={copied === asset.id}
                    language={language}
                    busy={update.isPending || remove.isPending || bulkRemove.isPending}
                    onSelect={(checked) => toggleSelected(asset.id, checked)}
                    onCopy={() => void copyUrl(asset)}
                    onSave={(next) => update.mutate({ id: asset.id, ...next })}
                    onDelete={() => remove.mutate(asset.id)}
                  />
                ))}
              </div>
            ) : (
              <MediaAssetTable
                rows={rows}
                selectedIds={selectedIds}
                copied={copied}
                language={language}
                busy={update.isPending || remove.isPending || bulkRemove.isPending}
                onSelect={toggleSelected}
                onCopy={(asset) => void copyUrl(asset)}
                onDelete={(asset) => remove.mutate(asset.id)}
              />
            )}
            <div className="media-pagination">
              {viewMode === "list" ? (
                <label className="media-page-size">
                  <span>{t(language, "resource.rowsPerPage")}</span>
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value) as (typeof MEDIA_PAGE_SIZES)[number]);
                      resetPaging();
                    }}
                  >
                    {MEDIA_PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </label>
              ) : <span />}
              <span className="text-sm text-muted-foreground">
                {t(language, "resource.paginationRange", {
                  start: String(rangeStart),
                  end: String(rangeEnd),
                  total: assets.data?.next_cursor ? `${rangeEnd}+` : String(rangeEnd),
                })}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={cursorHistory.length === 0} onClick={goPreviousPage}>
                  {t(language, "resource.previousPage")}
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={!assets.data?.next_cursor} onClick={goNextPage}>
                  {t(language, "resource.nextPage")}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </SectionCard>
    </div>
  );
}

function MediaBulkToolbar({
  language,
  selectedCount,
  allVisibleSelected,
  copied,
  busy,
  onToggleVisible,
  onClear,
  onCopy,
  onDelete,
}: {
  language: ReturnType<typeof usePreferences>["language"];
  selectedCount: number;
  allVisibleSelected: boolean;
  copied: boolean;
  busy: boolean;
  onToggleVisible: (checked: boolean) => void;
  onClear: () => void;
  onCopy: () => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <div className="media-bulk-toolbar">
      <label className="inline-flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          className="size-4 accent-[var(--primary)]"
          checked={allVisibleSelected}
          onChange={(event) => onToggleVisible(event.target.checked)}
        />
        {t(language, "media.selectVisible")}
      </label>
      <span className="text-sm text-muted-foreground">
        {t(language, "media.selectedCount", { count: String(selectedCount) })}
      </span>
      <div className="ms-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={selectedCount === 0} onClick={onClear}>
          {t(language, "media.clearSelection")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={selectedCount === 0 || busy} onClick={onCopy}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {t(language, "media.copySelectedUrls")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={selectedCount === 0 || busy} onClick={onDelete}>
          <Trash2 className="size-3.5" aria-hidden />
          {t(language, "media.deleteSelected")}
        </Button>
      </div>
    </div>
  );
}

function MediaAssetCard({
  asset,
  selected,
  copied,
  language,
  busy,
  onSelect,
  onCopy,
  onSave,
  onDelete,
}: {
  asset: AdminMediaAsset;
  selected: boolean;
  copied: boolean;
  language: ReturnType<typeof usePreferences>["language"];
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onCopy: () => void;
  onSave: (value: { alt: string; caption: string }) => void;
  onDelete: () => void;
}): React.ReactElement {
  const [alt, setAlt] = React.useState(asset.alt ?? "");
  const [caption, setCaption] = React.useState(asset.caption ?? "");

  React.useEffect(() => {
    setAlt(asset.alt ?? "");
    setCaption(asset.caption ?? "");
  }, [asset.alt, asset.caption]);

  const dirty = alt !== (asset.alt ?? "") || caption !== (asset.caption ?? "");
  const label = assetLabel(asset);

  return (
    <article className={`media-card album-card ${selected ? "is-selected" : ""}`}>
      <div className="media-thumb album-thumb">
        <label className="media-card-select" title={t(language, "media.selectAsset")}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
            aria-label={t(language, "media.selectAsset")}
          />
        </label>
        {asset.primaryUrl && asset.primaryMimeType?.startsWith("image/") ? (
          <img src={asset.primaryUrl} alt={asset.alt ?? label} className="h-full w-full object-cover" />
        ) : (
          <span className="media-kind">{asset.primaryMimeType ?? "FILE"}</span>
        )}
      </div>
      <div className="album-card-body">
        <div className="album-title-row">
          <div className="min-w-0">
            <h2 className="truncate text-base" title={label}>{label}</h2>
            <p className="truncate text-sm text-muted-foreground" title={asset.primaryUrl ?? asset.id}>{asset.primaryUrl ?? asset.id}</p>
          </div>
          <button
            type="button"
            className="row-action"
            onClick={onCopy}
            title={t(language, "media.copyUrl")}
            aria-label={t(language, "media.copyUrl")}
            disabled={!asset.primaryUrl}
          >
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          </button>
        </div>
        <div className="album-meta">
          <span>{formatBytes(asset.totalBytes)}</span>
          <span>{formatDate(asset.createdAt)}</span>
        </div>
        <label className="grid gap-1 text-sm">
          {t(language, "media.alt")}
          <input className="admin-input" value={alt} onChange={(event) => setAlt(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          {t(language, "media.caption")}
          <input className="admin-input" value={caption} onChange={(event) => setCaption(event.target.value)} />
        </label>
        <div className="album-actions">
          <span className="badge-status bg-accent text-accent-foreground">
            <Tags className="mr-1 size-3" aria-hidden />
            {asset.primaryMimeType ?? "media"}
          </span>
          <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => onSave({ alt, caption })}>
            {t(language, "entryEdit.save")}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onDelete} title={t(language, "crud.delete")}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </article>
  );
}

function MediaAssetTable({
  rows,
  selectedIds,
  copied,
  language,
  busy,
  onSelect,
  onCopy,
  onDelete,
}: {
  rows: AdminMediaAsset[];
  selectedIds: Set<string>;
  copied: string | null;
  language: ReturnType<typeof usePreferences>["language"];
  busy: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onCopy: (asset: AdminMediaAsset) => void;
  onDelete: (asset: AdminMediaAsset) => void;
}): React.ReactElement {
  return (
    <div className="media-list-shell">
      <table className="media-list-table">
        <thead>
          <tr>
            <th aria-label={t(language, "media.selectAsset")} />
            <th>{t(language, "media.asset")}</th>
            <th>{t(language, "media.type")}</th>
            <th>{t(language, "media.size")}</th>
            <th>{t(language, "media.createdAt")}</th>
            <th>{t(language, "collection.table.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((asset) => {
            const label = assetLabel(asset);
            const selected = selectedIds.has(asset.id);
            return (
              <tr key={asset.id} className={selected ? "is-selected" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    checked={selected}
                    onChange={(event) => onSelect(asset.id, event.target.checked)}
                    aria-label={t(language, "media.selectAsset")}
                  />
                </td>
                <td>
                  <div className="media-list-asset">
                    <div className="media-list-thumb">
                      {asset.primaryUrl && asset.primaryMimeType?.startsWith("image/") ? (
                        <img src={asset.primaryUrl} alt={asset.alt ?? label} />
                      ) : (
                        <span>{asset.primaryMimeType?.split("/")[1]?.toUpperCase() ?? "FILE"}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold" title={label}>{label}</h2>
                      <p className="truncate text-xs text-muted-foreground" title={asset.primaryUrl ?? asset.id}>
                        {asset.primaryUrl ?? asset.id}
                      </p>
                    </div>
                  </div>
                </td>
                <td>{asset.primaryMimeType ?? "-"}</td>
                <td>{formatBytes(asset.totalBytes)}</td>
                <td>{formatDate(asset.createdAt)}</td>
                <td>
                  <div className="media-list-actions">
                    <button
                      type="button"
                      className="row-action"
                      title={t(language, "media.copyUrl")}
                      aria-label={t(language, "media.copyUrl")}
                      disabled={!asset.primaryUrl}
                      onClick={() => onCopy(asset)}
                    >
                      {copied === asset.id ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                    </button>
                    <button
                      type="button"
                      className="row-action"
                      title={t(language, "crud.delete")}
                      aria-label={t(language, "crud.delete")}
                      disabled={busy}
                      onClick={() => onDelete(asset)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function assetLabel(asset: AdminMediaAsset): string {
  return asset.alt || asset.caption || asset.metadata?.filename || asset.id;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
