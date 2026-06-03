import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  Check,
  Copy,
  ImagePlus,
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
  const [sort, setSort] = React.useState<MediaSort>("newest");
  const [copied, setCopied] = React.useState<string | null>(null);

  const assets = useQuery<ListMediaAssetsResult>({
    queryKey: ["media-assets", submittedQuery, cursor ?? "0"],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
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
              setCursor(null);
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

        <div className="media-grid album-grid">
          {!assets.isLoading && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(language, "media.empty")}</p>
          ) : (
            rows.map((asset) => (
              <MediaAssetCard
                key={asset.id}
                asset={asset}
                copied={copied === asset.id}
                language={language}
                busy={update.isPending || remove.isPending}
                onCopy={() => void copyUrl(asset)}
                onSave={(next) => update.mutate({ id: asset.id, ...next })}
                onDelete={() => remove.mutate(asset.id)}
              />
            ))
          )}
        </div>

        {cursor || assets.data?.next_cursor ? (
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!cursor} onClick={() => setCursor(null)}>
              {t(language, "resource.previousPage")}
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={!assets.data?.next_cursor} onClick={() => setCursor(assets.data?.next_cursor ?? null)}>
              {t(language, "resource.nextPage")}
            </Button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

function MediaAssetCard({
  asset,
  copied,
  language,
  busy,
  onCopy,
  onSave,
  onDelete,
}: {
  asset: AdminMediaAsset;
  copied: boolean;
  language: ReturnType<typeof usePreferences>["language"];
  busy: boolean;
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
    <article className="media-card album-card">
      <div className="media-thumb album-thumb">
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
