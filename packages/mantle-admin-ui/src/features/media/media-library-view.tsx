import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Images, Search, Trash2, Upload, type LucideIcon } from "lucide-react";
import { useAdminLocation, useAdminRouter } from "../../app/router";
import { t } from "../../app/i18n";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { api } from "../../lib/api";
import type {
  MediaLibraryItem,
  MediaLibraryListResult,
  MediaPurposePolicy,
  SiteInfo,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader } from "../../ui/page";
import { uploadMediaAsset } from "./media-upload";

const TIMESTAMP_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Full-page media library (#434): thumbnail grid of committed assets,
 *  drag-drop + button upload, search, inline alt/caption edit, delete. */
export function MediaLibraryView(): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const params = new URLSearchParams(location.search);
  const searchTerm = params.get("search")?.trim() ?? "";

  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const purposes = site.data?.media?.purposes ?? [];

  return (
    <div>
      <PageHeader
        eyebrow={t(language, "nav.media")}
        title={t(language, "media.title")}
        description={t(language, "media.description")}
      />
      <MediaSearch searchTerm={searchTerm} language={language} />
      <MediaBrowser
        language={language}
        purposes={purposes}
        searchTerm={searchTerm}
        emptyIcon={Images}
      />
    </div>
  );
}

/** Shared browser: grid + upload + pagination. Reused by the full-page
 *  view and the entry-editor picker dialog. When `onPick` is set, each
 *  tile becomes selectable and delete/edit is suppressed (picker mode). */
export function MediaBrowser({
  language,
  purposes,
  searchTerm,
  emptyIcon,
  onPick,
}: {
  language: AdminLanguage;
  purposes: readonly MediaPurposePolicy[];
  searchTerm: string;
  emptyIcon: LucideIcon;
  onPick?: (item: MediaLibraryItem) => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const listKey = ["media", searchTerm] as const;

  const page1 = useQuery<MediaLibraryListResult>({
    queryKey: listKey,
    queryFn: () => {
      const qs = new URLSearchParams({ limit: "60" });
      if (searchTerm) qs.set("search", searchTerm);
      return api.get<MediaLibraryListResult>(`/media?${qs.toString()}`);
    },
  });

  // Appended "load more" pages live in their own state, separate from
  // the page-1 query. Reset ONLY when page 1's identity (the search
  // term) changes — NOT on every refetch. An in-place mutation (alt /
  // caption save, delete) refetches page 1 under the same key; resetting
  // on `page1.data` there would silently drop every already-loaded extra
  // page (#F3). `cursorAtSearch` is the cursor page 1 handed us for the
  // current search; `loadedCursor` is set once the user loads more, and
  // from then on it owns pagination independent of page-1 refetches.
  const [extraItems, setExtraItems] = React.useState<MediaLibraryItem[]>([]);
  const [loadedCursor, setLoadedCursor] = React.useState<string | null | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [loadMoreError, setLoadMoreError] = React.useState<unknown>(null);
  React.useEffect(() => {
    setExtraItems([]);
    setLoadedCursor(undefined);
    setLoadMoreError(null);
  }, [searchTerm]);

  // Effective next cursor: once the user has loaded extra pages,
  // `loadedCursor` owns it (so a page-1 refetch doesn't rewind it);
  // otherwise fall back to page 1's cursor.
  const nextCursor =
    loadedCursor !== undefined ? loadedCursor : page1.data?.next_cursor ?? null;

  const items = React.useMemo(
    () => [...(page1.data?.items ?? []), ...extraItems],
    [page1.data, extraItems],
  );

  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const canUpload = purposes.length > 0 && !uploading;

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["media"] });
  }, [queryClient]);

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      // Upload each file independently so one failure doesn't abort the
      // rest — successfully-uploaded files must still land in the grid,
      // and the operator should see how many failed rather than a single
      // opaque error hiding partial success (#F4).
      const results = await Promise.allSettled(
        list.map((file) => uploadMediaAsset({ file, purposes, language })),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      // Refresh if ANY upload succeeded so the new assets appear.
      if (succeeded > 0) refresh();
      if (failures.length > 0) {
        const detail = failures[0]?.reason;
        const detailMsg = detail instanceof Error ? detail.message : String(detail);
        setUploadError(
          `${t(language, "media.uploadFailed", {
            count: String(failures.length),
            total: String(list.length),
          })} ${detailMsg}`.trim(),
        );
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const qs = new URLSearchParams({ limit: "60", cursor: nextCursor });
      if (searchTerm) qs.set("search", searchTerm);
      const page = await api.get<MediaLibraryListResult>(`/media?${qs.toString()}`);
      setExtraItems((prev) => [...prev, ...page.items]);
      setLoadedCursor(page.next_cursor);
    } catch (err) {
      setLoadMoreError(err);
    } finally {
      setIsLoadingMore(false);
    }
  }

  return (
    <div
      onDragOver={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(false);
        void uploadFiles(e.dataTransfer.files);
      }}
      className={cn(
        "rounded-xl border border-dashed p-4 transition-colors",
        dragging ? "border-primary bg-accent/40" : "border-transparent",
      )}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="default"
          onClick={() => fileRef.current?.click()}
          disabled={!canUpload}
          title={purposes.length === 0 ? t(language, "media.noPurpose") : undefined}
        >
          <Upload className="size-4" aria-hidden />
          {uploading ? t(language, "media.uploading") : t(language, "media.upload")}
        </Button>
        <span className="text-xs text-muted-foreground">{t(language, "media.dropHere")}</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.currentTarget.files) void uploadFiles(e.currentTarget.files);
          }}
        />
      </div>

      {uploadError ? <p className="mb-3 text-xs text-destructive">{uploadError}</p> : null}
      {page1.isError ? <ErrorBox error={page1.error} /> : null}

      {page1.isLoading ? (
        <MediaSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          icon={emptyIcon}
          title={t(language, "media.empty.title")}
          description={
            searchTerm
              ? t(language, "media.empty.search", { search: searchTerm })
              : t(language, "media.empty.all")
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <MediaTile
              key={item.id}
              item={item}
              language={language}
              onChanged={refresh}
              onPick={onPick}
            />
          ))}
        </div>
      )}

      {loadMoreError ? <ErrorBox error={loadMoreError} /> : null}
      {nextCursor ? (
        <div className="mt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadMore()}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? t(language, "media.saving") : t(language, "media.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MediaTile({
  item,
  language,
  onChanged,
  onPick,
}: {
  item: MediaLibraryItem;
  language: AdminLanguage;
  onChanged: () => void;
  onPick?: (item: MediaLibraryItem) => void;
}): React.ReactElement {
  const [alt, setAlt] = React.useState(item.alt ?? "");
  const [caption, setCaption] = React.useState(item.caption ?? "");
  const [copied, setCopied] = React.useState(false);
  const dirty = alt !== (item.alt ?? "") || caption !== (item.caption ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.patch<MediaLibraryItem>(`/media/${encodeURIComponent(item.id)}`, { alt, caption }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () =>
      api.delete<{ deleted: boolean }>(`/media/${encodeURIComponent(item.id)}`),
    onSuccess: onChanged,
  });

  function confirmDelete(): void {
    if (typeof window !== "undefined" && !window.confirm(t(language, "media.deleteConfirm"))) {
      return;
    }
    remove.mutate();
  }

  async function copyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--glass-border)] bg-card/50">
      <div className="relative aspect-square bg-muted/40">
        {item.primaryUrl ? (
          <img
            src={item.primaryUrl}
            alt={item.alt ?? ""}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Images className="size-6" aria-hidden />
          </div>
        )}
        {onPick ? (
          <button
            type="button"
            className="absolute inset-0 flex items-end justify-center bg-black/0 p-2 opacity-0 transition hover:bg-black/40 hover:opacity-100"
            onClick={() => onPick(item)}
          >
            <span className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
              {t(language, "media.use")}
            </span>
          </button>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="group inline-flex items-center gap-1 font-mono hover:text-foreground"
            title={t(language, "media.copyId")}
            onClick={() => void copyId()}
          >
            {item.id.slice(0, 8)}
            {copied ? (
              <Check className="size-3 text-[color:var(--success)]" aria-hidden />
            ) : (
              <Copy className="size-3 opacity-40 transition-opacity group-hover:opacity-80" aria-hidden />
            )}
          </button>
          <span>{formatByteSize(item.byteSize)}</span>
        </div>

        {onPick ? null : (
          <>
            <input
              className="admin-input h-8 text-sm"
              value={alt}
              placeholder={t(language, "media.altPlaceholder")}
              aria-label={t(language, "media.alt")}
              onChange={(e) => setAlt(e.target.value)}
            />
            <input
              className="admin-input h-8 text-sm"
              value={caption}
              placeholder={t(language, "media.captionPlaceholder")}
              aria-label={t(language, "media.caption")}
              onChange={(e) => setCaption(e.target.value)}
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {item.primaryUrl ? (
                  <a
                    className="row-action"
                    href={item.primaryUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={t(language, "media.open")}
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : null}
                <button
                  type="button"
                  className="row-action"
                  title={t(language, "media.delete")}
                  disabled={remove.isPending}
                  onClick={confirmDelete}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending
                  ? t(language, "media.saving")
                  : save.isSuccess && !dirty
                  ? t(language, "media.saved")
                  : t(language, "media.save")}
              </Button>
            </div>
            {save.isError ? <ErrorBox error={save.error} /> : null}
            {remove.isError ? <ErrorBox error={remove.error} /> : null}
          </>
        )}
        <p className="text-[11px] text-muted-foreground">
          {t(language, "media.uploaded", { date: formatTimestamp(item.createdAt) })}
        </p>
      </div>
    </div>
  );
}

function MediaSearch({
  searchTerm,
  language,
}: {
  searchTerm: string;
  language: AdminLanguage;
}): React.ReactElement {
  const { navigate } = useAdminRouter();
  const [draft, setDraft] = React.useState(searchTerm);
  React.useEffect(() => setDraft(searchTerm), [searchTerm]);
  return (
    <form
      className="mb-4 max-w-xl"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const next = draft.trim();
        const p = new URLSearchParams();
        if (next) p.set("search", next);
        const suffix = p.toString();
        // SPA navigation (#F8) — a hard reload here dropped the whole
        // client app state on every search.
        navigate(`/admin/media${suffix ? `?${suffix}` : ""}`);
      }}
    >
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          className="admin-input h-10 pl-9"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t(language, "media.searchPlaceholder")}
        />
      </label>
    </form>
  );
}

function MediaSkeleton(): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-[var(--glass-border)]">
          <div className="aspect-square animate-pulse bg-muted" />
          <div className="space-y-2 p-3">
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-8 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  try {
    return TIMESTAMP_FMT.format(new Date(ms));
  } catch {
    return "-";
  }
}

function formatByteSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
