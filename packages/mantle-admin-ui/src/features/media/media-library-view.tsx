import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  Check,
  Copy,
  Grid2X2,
  ImagePlus,
  List,
  Search,
  Tags,
  Trash2,
} from "lucide-react";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { AdminMediaAsset, ListMediaAssetsResult, SiteInfo } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { uploadMediaAsset } from "./media-upload";

type MediaSort = "newest" | "name" | "type";
type MediaViewMode = "grid" | "list";

const MEDIA_PAGE_SIZES = [10, 30, 50, 100] as const;

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

  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
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
      if (sort === "type") {
        return (a.primaryMimeType ?? "").localeCompare(b.primaryMimeType ?? "") || assetLabel(a).localeCompare(assetLabel(b));
      }
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
  const mediaPurposes = site.data?.media?.purposes ?? [];

  const resetPaging = React.useCallback(() => {
    setCursor(null);
    setCursorHistory([]);
    setSelectedIds(new Set());
  }, []);

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadMediaAsset({
        file,
        purposes: mediaPurposes,
        preferredPurpose: "content",
        alt: file.name.replace(/\.[^.]+$/, ""),
      }),
    onSuccess: () => {
      resetPaging();
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
    onSuccess: (_data, id) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["media-assets"] });
    },
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
      await navigator.clipboard.writeText(new URL(asset.primaryUrl, window.location.origin).toString());
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
            <Button
              type="button"
              disabled={upload.isPending || mediaPurposes.length === 0}
              onClick={() => fileRef.current?.click()}
              title={mediaPurposes.length === 0 ? t(language, "entryEdit.noMediaPurpose") : t(language, "media.upload")}
            >
              <ImagePlus className="size-4" aria-hidden />
              {upload.isPending ? t(language, "media.uploading") : t(language, "media.upload")}
            </Button>
          </>
        }
      />

      {upload.isError ? <ErrorBox error={upload.error} /> : null}
      {assets.isError ? <ErrorBox error={assets.error} /> : null}
      {remove.isError ? <ErrorBox error={remove.error} /> : null}
      {bulkRemove.isError ? <ErrorBox error={bulkRemove.error} /> : null}

      <SectionCard className="media-album">
        <form
          className="media-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            resetPaging();
            setSubmittedQuery(query.trim());
          }}
        >
          <label className="admin-search media-search">
            <Search className="size-4" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(language, "media.search")}
            />
          </label>
          <label className="media-sort" title={t(language, "media.sort")}>
            <ArrowDownUp className="size-4" aria-hidden />
            <select value={sort} onChange={(event) => setSort(event.target.value as MediaSort)}>
              <option value="newest">{t(language, "media.sort.newest")}</option>
              <option value="name">{t(language, "media.sort.name")}</option>
              <option value="type">{t(language, "media.sort.type")}</option>
            </select>
          </label>
          <div className="segmented-control" aria-label={t(language, "media.viewMode")}>
            <button type="button" data-active={viewMode === "grid"} onClick={() => setViewMode("grid")}>
              <Grid2X2 className="mr-1 inline size-4" aria-hidden />
              {t(language, "media.viewGrid")}
            </button>
            <button type="button" data-active={viewMode === "list"} onClick={() => setViewMode("list")}>
              <List className="mr-1 inline size-4" aria-hidden />
              {t(language, "media.viewList")}
            </button>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--glass-border)] bg-background/35 p-3 text-sm">
          <label className="inline-flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(event) => toggleVisible(event.target.checked)}
            />
            {t(language, "media.selected", { count: String(selectedIds.size) })}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={selectedAssets.length === 0} onClick={copySelectedUrls}>
              {copied === "selected" ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {t(language, "media.copySelected")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={selectedAssets.length === 0 || bulkRemove.isPending} onClick={deleteSelected}>
              <Trash2 className="size-3.5" aria-hidden />
              {t(language, "media.deleteSelected")}
            </Button>
          </div>
        </div>

        {assets.isLoading ? <div className="glass-card h-56 animate-pulse" /> : null}
        {!assets.isLoading && rows.length === 0 ? (
          <div className="media-dropzone-compact">
            <ImagePlus className="size-5" aria-hidden />
            <strong>{t(language, "media.empty")}</strong>
            <span>{t(language, "media.dropzoneHint")}</span>
          </div>
        ) : null}
        {!assets.isLoading && rows.length > 0 && viewMode === "grid" ? (
          <div className="media-grid album-grid">
            {rows.map((asset) => (
              <MediaCard
                key={asset.id}
                asset={asset}
                selected={selectedIds.has(asset.id)}
                copied={copied === asset.id}
                updatePending={update.isPending}
                deletePending={remove.isPending}
                onSelect={(checked) => toggleSelected(asset.id, checked)}
                onCopy={() => void copyUrl(asset)}
                onUpdate={(alt, caption) => update.mutate({ id: asset.id, alt, caption })}
                onDelete={() => {
                  if (typeof window !== "undefined" && !window.confirm(t(language, "media.deleteConfirm"))) return;
                  remove.mutate(asset.id);
                }}
              />
            ))}
          </div>
        ) : null}
        {!assets.isLoading && rows.length > 0 && viewMode === "list" ? (
          <MediaList
            rows={rows}
            selectedIds={selectedIds}
            copied={copied}
            updatePending={update.isPending}
            deletePending={remove.isPending}
            onSelect={toggleSelected}
            onCopy={(asset) => void copyUrl(asset)}
            onUpdate={(asset, alt, caption) => update.mutate({ id: asset.id, alt, caption })}
            onDelete={(asset) => {
              if (typeof window !== "undefined" && !window.confirm(t(language, "media.deleteConfirm"))) return;
              remove.mutate(asset.id);
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-border)] pt-4 text-sm text-muted-foreground">
          <span>{t(language, "media.range", { start: String(rangeStart), end: String(rangeEnd) })}</span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="media-sort">
              {t(language, "media.pageSize")}
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
            <Button type="button" variant="outline" size="sm" disabled={cursorHistory.length === 0} onClick={goPreviousPage}>
              {t(language, "media.previous")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!assets.data?.next_cursor} onClick={goNextPage}>
              {t(language, "media.next")}
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function MediaCard({
  asset,
  selected,
  copied,
  updatePending,
  deletePending,
  onSelect,
  onCopy,
  onUpdate,
  onDelete,
}: {
  asset: AdminMediaAsset;
  selected: boolean;
  copied: boolean;
  updatePending: boolean;
  deletePending: boolean;
  onSelect: (checked: boolean) => void;
  onCopy: () => void;
  onUpdate: (alt: string, caption: string) => void;
  onDelete: () => void;
}): React.ReactElement {
  const { language } = usePreferences();
  const [alt, setAlt] = React.useState(asset.alt ?? "");
  const [caption, setCaption] = React.useState(asset.caption ?? "");
  React.useEffect(() => {
    setAlt(asset.alt ?? "");
    setCaption(asset.caption ?? "");
  }, [asset.alt, asset.caption]);

  return (
    <article className="media-card album-card">
      <div className="media-thumb album-thumb bg-card">
        <label className="absolute start-2 top-2 z-10 rounded-md bg-background/80 px-2 py-1 text-xs font-semibold">
          <input
            type="checkbox"
            className="mr-1"
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
          {asset.primaryMimeType ? mimeShort(asset.primaryMimeType) : "FILE"}
        </label>
        {asset.primaryUrl ? (
          <img src={asset.primaryUrl} alt={asset.alt ?? ""} className="size-full object-contain" />
        ) : (
          <span className="grid size-full place-items-center text-sm text-muted-foreground">{asset.id}</span>
        )}
      </div>
      <div className="album-card-body">
        <div className="album-title-row">
          <div className="min-w-0">
            <h2 className="truncate text-base" title={assetLabel(asset)}>{assetLabel(asset)}</h2>
            <p className="truncate text-sm text-muted-foreground" title={asset.id}>{asset.id}</p>
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
            {asset.primaryMimeType ?? "file"}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={updatePending} onClick={() => onUpdate(alt, caption)}>
              {t(language, "crud.saveTitle")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={deletePending} onClick={onDelete} title={t(language, "crud.delete")}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function MediaList({
  rows,
  selectedIds,
  copied,
  updatePending,
  deletePending,
  onSelect,
  onCopy,
  onUpdate,
  onDelete,
}: {
  rows: AdminMediaAsset[];
  selectedIds: Set<string>;
  copied: string | null;
  updatePending: boolean;
  deletePending: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onCopy: (asset: AdminMediaAsset) => void;
  onUpdate: (asset: AdminMediaAsset, alt: string, caption: string) => void;
  onDelete: (asset: AdminMediaAsset) => void;
}): React.ReactElement {
  const { language } = usePreferences();
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--glass-border)]">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead className="bg-accent/70 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-10 px-3 py-3" />
            <th className="px-3 py-3">{t(language, "media.asset")}</th>
            <th className="px-3 py-3">{t(language, "media.alt")}</th>
            <th className="px-3 py-3">{t(language, "media.caption")}</th>
            <th className="px-3 py-3">{t(language, "media.size")}</th>
            <th className="px-3 py-3">{t(language, "collection.table.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((asset) => (
            <MediaListRow
              key={asset.id}
              asset={asset}
              selected={selectedIds.has(asset.id)}
              copied={copied === asset.id}
              updatePending={updatePending}
              deletePending={deletePending}
              onSelect={(checked) => onSelect(asset.id, checked)}
              onCopy={() => onCopy(asset)}
              onUpdate={(alt, caption) => onUpdate(asset, alt, caption)}
              onDelete={() => onDelete(asset)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MediaListRow({
  asset,
  selected,
  copied,
  updatePending,
  deletePending,
  onSelect,
  onCopy,
  onUpdate,
  onDelete,
}: {
  asset: AdminMediaAsset;
  selected: boolean;
  copied: boolean;
  updatePending: boolean;
  deletePending: boolean;
  onSelect: (checked: boolean) => void;
  onCopy: () => void;
  onUpdate: (alt: string, caption: string) => void;
  onDelete: () => void;
}): React.ReactElement {
  const { language } = usePreferences();
  const [alt, setAlt] = React.useState(asset.alt ?? "");
  const [caption, setCaption] = React.useState(asset.caption ?? "");
  React.useEffect(() => {
    setAlt(asset.alt ?? "");
    setCaption(asset.caption ?? "");
  }, [asset.alt, asset.caption]);
  return (
    <tr className="border-t border-[var(--glass-border)] bg-card/50 align-middle">
      <td className="px-3 py-3">
        <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} />
      </td>
      <td className="px-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md border border-[var(--glass-border)] bg-background">
            {asset.primaryUrl ? <img src={asset.primaryUrl} alt={asset.alt ?? ""} className="size-full object-contain" /> : null}
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold" title={assetLabel(asset)}>{assetLabel(asset)}</p>
            <p className="truncate text-xs text-muted-foreground" title={asset.id}>{asset.id}</p>
            <p className="text-xs text-muted-foreground">{asset.primaryMimeType ?? "file"} · {formatDate(asset.createdAt)}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <input className="admin-input min-w-48" value={alt} onChange={(event) => setAlt(event.target.value)} />
      </td>
      <td className="px-3 py-3">
        <input className="admin-input min-w-48" value={caption} onChange={(event) => setCaption(event.target.value)} />
      </td>
      <td className="whitespace-nowrap px-3 py-3">{formatBytes(asset.totalBytes)}</td>
      <td className="px-3 py-3">
        <div className="flex gap-2">
          <button type="button" className="row-action" disabled={!asset.primaryUrl} onClick={onCopy} title={t(language, "media.copyUrl")}>
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          </button>
          <Button type="button" variant="outline" size="sm" disabled={updatePending} onClick={() => onUpdate(alt, caption)}>
            {t(language, "crud.saveTitle")}
          </Button>
          <button type="button" className="row-action" disabled={deletePending} onClick={onDelete} title={t(language, "crud.delete")}>
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      </td>
    </tr>
  );
}

function assetLabel(asset: AdminMediaAsset): string {
  return asset.alt || asset.caption || asset.id;
}

function mimeShort(value: string): string {
  return value.replace(/^image\//, "").toUpperCase();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
