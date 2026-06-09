import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, BadgePercent, Check, Clock3, Copy, ExternalLink, ImagePlus, Info, LayoutTemplate, Link2, PackageCheck, Plus, Save, Tag, Trash2, Upload, X } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t, type I18nKey } from "../../app/i18n";
import { api } from "../../lib/api";
import type { AdminMediaAsset, EntryEditorPayload, JsonSchema, ListMediaAssetsResult, RelatedEntrySection, SiteSettings } from "../../lib/types";
import { Button } from "../../ui/button";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { RichTextEditor } from "../editor/rich-text-editor";
import { collectionTitle } from "./collection-labels";

export function EntryEditView({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();
  const query = useQuery<EntryEditorPayload>({
    queryKey: ["entry-editor", collectionName, entryId],
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}/editor`),
  });
  const [data, setData] = React.useState<Record<string, unknown> | null>(null);
  React.useEffect(() => {
    if (query.data) setData(query.data.entry.data);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}/editor`, {
        data: nextData,
      }),
    onSuccess: (payload) => {
      setData(payload.entry.data);
    },
  });
  const deleteEntry = useMutation({
    mutationFn: () => api.delete<{ removed: boolean }>(`/entries/${encodeURIComponent(entryId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["entries", collectionName] });
      window.location.href = `/admin/c/${encodeURIComponent(collectionName)}`;
    },
  });

  if (query.isLoading) return <div className="glass-card h-64 animate-pulse" />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data || !data) return <ErrorBox error={new Error("Missing entry editor payload.")} />;

  const payload = query.data;
  const title = entryTitle(data, payload.entry.id);
  const dirty = JSON.stringify(data) !== JSON.stringify(payload.entry.data);
  const parentLink = parentAdminLink(payload.collection, data);
  const inlineRelated = payload.related.filter((section) => isPrimaryCommerceSection(section, payload.collection.name));
  const sidebarRelated = payload.related.filter((section) => !isPrimaryCommerceSection(section, payload.collection.name));
  const productTranslations = inlineRelated.filter((section) => section.collection.name === "product-translations");
  const productSkus = inlineRelated.filter((section) => section.collection.name === "product-skus");
  const orderItems = inlineRelated.filter((section) => section.collection.name === "order_items");
  const genericInlineRelated = inlineRelated.filter(
    (section) => !(payload.collection.name === "orders" && section.collection.name === "order_items"),
  );
  const isProduct = payload.collection.name === "products";
  const isProductSku = payload.collection.name === "product-skus";
  const isProductTranslation = payload.collection.name === "product-translations";
  const isPageTranslation = payload.collection.name === "page-translations";
  const isOrder = payload.collection.name === "orders";
  const isOrderItem = payload.collection.name === "order_items";
  const isInventorySnapshot = payload.collection.name === "inventory_snapshots";
  const showDeleteAction = isProduct || isProductSku || isProductTranslation;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={`/admin/c/${encodeURIComponent(collectionName)}`}
              className="inline-flex items-center gap-2 hover:underline"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              {t(language, "entryEdit.back", { name: collectionTitle(payload.collection, language) })}
            </a>
            {parentLink ? (
              <>
                <span className="text-foreground/30">/</span>
                <a href={parentLink.href} className="hover:underline">
                  {t(language, "entryEdit.parent", { name: parentLink.label })}
                </a>
              </>
            ) : null}
          </span>
        }
        title={title}
        description={t(language, "entryEdit.body", {
          name: collectionTitle(payload.collection, language),
        })}
        actions={
          <>
            <StatusBadge status={payload.entry.status} />
            <Button
              type="button"
              onClick={() => save.mutate(data)}
              disabled={save.isPending || !dirty}
              title={t(language, "entryEdit.saveTooltip")}
            >
              <Save className="size-4" aria-hidden />
              {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
            </Button>
          </>
        }
      />

      {save.isError ? <ErrorBox error={save.error} /> : null}
      {deleteEntry.isError ? <ErrorBox error={deleteEntry.error} /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          {isProduct ? (
            <ProductCommerceFields
              value={data}
              onChange={setData}
              language={language}
            />
          ) : isProductSku ? (
            <ProductSkuEntryFields
              value={data}
              onChange={setData}
              language={language}
            />
          ) : isProductTranslation ? (
            <ProductTranslationEntryFields
              value={data}
              onChange={setData}
              language={language}
            />
          ) : isPageTranslation ? (
            <PageTranslationEntryFields
              value={data}
              onChange={setData}
              language={language}
            />
          ) : isOrder ? (
            <OrderManagementFields
              value={data}
              onChange={setData}
              language={language}
              showEmbeddedItems={orderItems.length === 0}
            />
          ) : isOrderItem ? (
            <OrderLineItemFields
              value={data}
              onChange={setData}
              language={language}
            />
          ) : isInventorySnapshot ? (
            <InventorySnapshotFields
              value={data}
              onChange={setData}
              language={language}
            />
          ) : (
            <SectionCard>
              <SectionTitle
                title={t(language, "entryEdit.fields")}
                body={friendlyDescription(payload.collection.description)}
              />
              <SchemaFields
                schema={payload.collection.schema}
                value={data}
                path={[]}
                onChange={setData}
                language={language}
              />
            </SectionCard>
          )}

          {productTranslations.length > 0 ? (
            <RelatedSections
              sections={productTranslations}
              language={language}
              parentTitle={title}
              onSaved={() => void query.refetch()}
            />
          ) : null}

          {productSkus.length > 0 ? (
            <RelatedSections
              sections={productSkus}
              language={language}
              parentTitle={title}
              onSaved={() => void query.refetch()}
            />
          ) : null}

          {orderItems.length > 0 ? (
            <OrderLineItemsSection
              section={orderItems[0]}
              language={language}
              onSaved={() => void query.refetch()}
            />
          ) : null}

          {!isProduct && genericInlineRelated.length > 0 ? (
            <RelatedSections
              sections={genericInlineRelated}
              language={language}
              parentTitle={title}
              onSaved={() => void query.refetch()}
            />
          ) : null}
        </div>

        <div className="space-y-4">
          <SectionCard>
            <SectionTitle
              title={t(language, "entryEdit.meta")}
              body={`${payload.entry.collection} / ${payload.entry.id}`}
            />
            <dl className="space-y-3 text-sm">
              <MetaRow label={t(language, "collection.table.status")} value={<StatusBadge status={payload.entry.status} />} />
              <MetaRow label={t(language, "collection.table.locale")} value={payload.entry.locale ?? "-"} />
              <MetaRow label={t(language, "collection.table.version")} value={`v${payload.entry.version}`} />
            </dl>
          </SectionCard>
          {showDeleteAction ? (
            <SectionCard className="border-destructive/20 bg-destructive/5 shadow-sm">
              <SectionTitle
                title={t(language, "entryEdit.dangerZone")}
                body={t(language, "entryEdit.deleteBody")}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleteEntry.isPending}
                title={t(language, "crud.deleteTooltip", { name: title })}
                onClick={() => {
                  if (typeof window !== "undefined" && !window.confirm(t(language, "crud.deleteConfirm", { name: title }))) {
                    return;
                  }
                  deleteEntry.mutate();
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
                {deleteEntry.isPending ? t(language, "crud.saving") : t(language, "crud.delete")}
              </Button>
            </SectionCard>
          ) : null}
          {sidebarRelated.length > 0 ? (
            <RelatedSections
              sections={sidebarRelated}
              language={language}
              parentTitle={title}
              onSaved={() => void query.refetch()}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  title,
  body,
  action,
  className,
}: {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={`mb-4 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {body ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p> : null}
    </div>
  );
}

function ProductCommerceFields({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const uploadInputRef = React.useRef<HTMLInputElement | null>(null);
  const [cropFile, setCropFile] = React.useState<File | null>(null);
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  const coverAssetId = stringForInput(value["coverAssetId"]);
  const productImages = recordArray(value["images"]);
  const galleryPreviewIds = uniqueStrings([
    ...productImages.map((image) => stringForInput(image["assetId"])),
    coverAssetId,
  ]);
  const mediaAssets = useMediaAssetsById(galleryPreviewIds);
  const primaryAssetId = coverAssetId || galleryPreviewIds[0] || "";
  const primaryAsset = primaryAssetId ? mediaAssets.get(primaryAssetId) : undefined;
  const setImages = (nextImages: Record<string, unknown>[]): void => {
    const firstAssetId = stringForInput(nextImages[0]?.["assetId"]);
    onChange({
      ...value,
      images: nextImages,
      coverAssetId: coverAssetId || firstAssetId,
    });
  };
  const setCoverAssetId = (next: string): void => onChange({ ...value, coverAssetId: next });
  const addUploadedAsset = (asset: AdminMediaAsset): void => {
    const nextImage = { assetId: asset.id, alt: asset.alt ?? "" };
    const nextImages = [...productImages.filter((image) => stringForInput(image["assetId"]) !== asset.id), nextImage];
    onChange({
      ...value,
      images: nextImages,
      coverAssetId: coverAssetId || asset.id,
    });
  };
  return (
    <>
      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.productVisual")}
          body={t(language, "entryEdit.productVisualBody")}
        />
        <div className="grid gap-5 lg:grid-cols-[minmax(24rem,34rem)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-lg border border-[var(--glass-border)] bg-background/50 p-3 shadow-sm">
            <div className="relative grid min-h-80 place-items-center overflow-hidden rounded-md border border-[var(--glass-border)] bg-[radial-gradient(circle_at_30%_20%,rgba(124,184,255,0.22),transparent_32%),linear-gradient(135deg,rgba(26,48,98,0.08),rgba(127,231,210,0.12))]">
              {mediaAssetUrl(primaryAsset) ? (
                <img
                  src={mediaAssetUrl(primaryAsset) ?? undefined}
                  alt={primaryAsset?.alt ?? t(language, "entryEdit.productVisual")}
                  className="h-full max-h-[26rem] w-full object-contain p-2"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-center">
                  <ImagePlus className="mb-2 size-8 text-primary" aria-hidden />
                  <p className="text-sm font-semibold text-foreground">{t(language, "entryEdit.coverEmpty")}</p>
                </div>
              )}
              <div className="absolute left-3 top-3 rounded-full border border-white/50 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur-md dark:bg-slate-950/65">
                {galleryPreviewIds.length > 0 ? t(language, "entryEdit.coverLinked") : t(language, "entryEdit.coverEmpty")}
              </div>
              {primaryAssetId ? (
                <code className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-md">
                  {primaryAssetId}
                </code>
              ) : null}
            </div>
            {galleryPreviewIds.length > 1 ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {galleryPreviewIds.slice(0, 6).map((assetId, index) => (
                  <MediaAssetThumb
                    key={`${assetId}:${index}`}
                    assetId={assetId}
                    asset={mediaAssets.get(assetId)}
                    label={index === 0 ? t(language, "entryEdit.coverSlide") : t(language, "entryEdit.slideNumber", { number: String(index + 1) })}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className="space-y-3">
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (file) setCropFile(file);
                event.target.value = "";
              }}
            />
            <FieldShell label={t(language, "entryEdit.coverAsset")} hint={t(language, "entryEdit.coverAssetHint")}>
              <input
                className="admin-input"
                value={coverAssetId}
                onChange={(event) => setCoverAssetId(event.target.value)}
                placeholder="media asset id"
              />
            </FieldShell>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => uploadInputRef.current?.click()}>
                <Upload className="size-3.5" aria-hidden />
                {t(language, "entryEdit.uploadAndCrop")}
              </Button>
              <Button asChild variant="secondary" size="sm">
                <a href="/admin/media">
                  <ImagePlus className="size-3.5" aria-hidden />
                  {t(language, "media.page.title")}
                </a>
              </Button>
              <CopyValueButton value={coverAssetId} language={language} />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t(language, "entryEdit.productImageGuidance")}
            </p>
          </div>
        </div>
        {cropFile ? (
          <ProductImageCropDialog
            file={cropFile}
            language={language}
            onClose={() => setCropFile(null)}
            onUploaded={(asset) => {
              addUploadedAsset(asset);
              setCropFile(null);
            }}
          />
        ) : null}
        <ProductImageSliderEditor
          value={productImages}
          coverAssetId={coverAssetId}
          onChange={setImages}
          onUseAsCover={setCoverAssetId}
          language={language}
        />
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.productBase")}
          body={t(language, "entryEdit.productBaseBody")}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label={t(language, "entryEdit.slug")} required>
            <input
              className="admin-input"
              value={stringForInput(value["slug"])}
              onChange={(event) => setField("slug", event.target.value)}
            />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.operatorSku")}>
            <input
              className="admin-input"
              value={stringForInput(value["sku"])}
              onChange={(event) => setField("sku", event.target.value)}
            />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.inventoryMode")} required>
            <select
              className="admin-input"
              value={stringForInput(value["inventoryMode"])}
              onChange={(event) => setField("inventoryMode", event.target.value)}
            >
              <option value="">{t(language, "entryEdit.emptyOption")}</option>
              <option value="tracked">{t(language, "entryEdit.inventoryTracked")}</option>
              <option value="untracked">{t(language, "entryEdit.inventoryUntracked")}</option>
            </select>
          </FieldShell>
        </div>
      </SectionCard>
    </>
  );
}

function useMediaAssetsById(ids: string[]): ReadonlyMap<string, AdminMediaAsset> {
  const uniqueIds = React.useMemo(() => uniqueStrings(ids), [ids.join("|")]);
  const query = useQuery({
    queryKey: ["media-assets-by-id", uniqueIds],
    enabled: uniqueIds.length > 0,
    queryFn: async () => {
      const pairs = await Promise.all(uniqueIds.map(async (id) => {
        const params = new URLSearchParams({ search: id, limit: "10" });
        const result = await api.get<ListMediaAssetsResult>(`/media/assets?${params.toString()}`);
        return [id, result.items.find((asset) => asset.id === id) ?? null] as const;
      }));
      return new Map(pairs.filter((pair): pair is readonly [string, AdminMediaAsset] => pair[1] !== null));
    },
  });
  return query.data ?? new Map<string, AdminMediaAsset>();
}

function MediaAssetThumb({
  assetId,
  asset,
  label,
}: {
  assetId: string;
  asset?: AdminMediaAsset;
  label: string;
}): React.ReactElement {
  const url = mediaAssetUrl(asset);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-white/35 bg-white/55 shadow-sm dark:bg-slate-950/45">
      <div className="aspect-[4/3] bg-muted/50">
        {url ? (
          <img src={url} alt={asset?.alt ?? label} className="h-full w-full object-contain p-1" />
        ) : (
          <div className="grid h-full place-items-center">
            <ImagePlus className="size-4 text-muted-foreground" aria-hidden />
          </div>
        )}
      </div>
      <div className="px-2 py-1.5">
        <span className="label-eyebrow">{label}</span>
        <code className="block truncate text-[11px] text-muted-foreground">{assetId}</code>
      </div>
    </div>
  );
}

function mediaAssetUrl(asset: AdminMediaAsset | undefined): string | null {
  return asset?.primaryUrl ?? asset?.variants.find((variant) => variant.role === "primary")?.publicUrl ?? asset?.variants[0]?.publicUrl ?? null;
}

type ProductCropAspect = "16:10" | "4:3" | "1:1";

function ProductImageCropDialog({
  file,
  language,
  onClose,
  onUploaded,
}: {
  file: File;
  language: AdminLanguage;
  onClose: () => void;
  onUploaded: (asset: AdminMediaAsset) => void;
}): React.ReactElement {
  const [imageUrl, setImageUrl] = React.useState<string>("");
  const [aspect, setAspect] = React.useState<ProductCropAspect>("16:10");
  const [zoom, setZoom] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const upload = useMutation({
    mutationFn: async () => {
      setError(null);
      const blob = await cropImageFile(file, aspect, zoom);
      return uploadProductMediaAsset(blob, file.name, file.type || blob.type);
    },
    onSuccess: onUploaded,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-xl border border-[var(--glass-border)] bg-background p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="label-eyebrow">{t(language, "entryEdit.productVisual")}</p>
            <h3 className="text-xl font-semibold">{t(language, "entryEdit.cropProductImage")}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t(language, "entryEdit.cropProductImageBody")}</p>
          </div>
          <button type="button" className="row-action" title={t(language, "guide.close")} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="rounded-lg border border-[var(--glass-border)] bg-muted/30 p-3">
            <div className={`grid overflow-hidden rounded-md bg-background ${aspectClassName(aspect)}`}>
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
                />
              ) : null}
            </div>
          </div>
          <div className="space-y-4">
            <FieldShell label={t(language, "entryEdit.cropAspect")}>
              <select className="admin-input" value={aspect} onChange={(event) => setAspect(event.target.value as ProductCropAspect)}>
                <option value="16:10">16:10</option>
                <option value="4:3">4:3</option>
                <option value="1:1">1:1</option>
              </select>
            </FieldShell>
            <FieldShell label={t(language, "entryEdit.cropZoom")}>
              <input
                type="range"
                min="1"
                max="2"
                step="0.05"
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
                className="w-full accent-[var(--primary)]"
              />
            </FieldShell>
            <p className="text-xs leading-5 text-muted-foreground">{t(language, "entryEdit.productImageGuidance")}</p>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={upload.isPending}>
            {t(language, "crud.cancelTitle")}
          </Button>
          <Button type="button" onClick={() => upload.mutate()} disabled={upload.isPending}>
            <Upload className="size-4" aria-hidden />
            {upload.isPending ? t(language, "media.uploading") : t(language, "entryEdit.cropAndUpload")}
          </Button>
        </div>
      </div>
    </div>
  );
}

async function uploadProductMediaAsset(blob: Blob, filename: string, sourceType: string): Promise<AdminMediaAsset> {
  const mimeType = supportedImageMime(sourceType || blob.type);
  const uploadFile = new File([blob], croppedFilename(filename, mimeType), { type: mimeType });
  const created = await api.post<MediaUploadResponse>("/media/uploads", {
    filename: uploadFile.name,
    purpose: "product-image",
    variants: [{ mimeType, byteSize: uploadFile.size, role: "primary" }],
    alt: filename.replace(/\.[^.]+$/, ""),
  });
  const primary = created.capabilities.find((cap) => cap.role === "primary") ?? created.capabilities[0];
  if (!primary) throw new Error("Upload capability missing.");
  await fetch(primary.uploadUrl, {
    method: primary.method,
    headers: primary.requiredHeaders ?? { "Content-Type": mimeType },
    body: uploadFile,
  });
  return api.post<AdminMediaAsset>(
    `/media/uploads/${encodeURIComponent(created.uploadGroupId)}/commit`,
    { alt: filename.replace(/\.[^.]+$/, "") },
  );
}

async function cropImageFile(file: File, aspect: ProductCropAspect, zoom: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const ratio = aspectRatioValue(aspect);
  const sourceWidth = bitmap.width / zoom;
  const sourceHeight = bitmap.height / zoom;
  let cropWidth = sourceWidth;
  let cropHeight = cropWidth / ratio;
  if (cropHeight > sourceHeight) {
    cropHeight = sourceHeight;
    cropWidth = cropHeight * ratio;
  }
  const sourceX = Math.max(0, (bitmap.width - cropWidth) / 2);
  const sourceY = Math.max(0, (bitmap.height - cropHeight) / 2);
  const outputWidth = aspect === "1:1" ? 1200 : 1600;
  const outputHeight = Math.round(outputWidth / ratio);
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outputWidth, outputHeight);
  ctx.drawImage(bitmap, sourceX, sourceY, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight);
  bitmap.close?.();
  const mimeType = supportedImageMime(file.type);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, mimeType === "image/png" ? undefined : 0.9));
  if (!blob) throw new Error("Unable to crop image.");
  return blob;
}

function aspectRatioValue(aspect: ProductCropAspect): number {
  if (aspect === "4:3") return 4 / 3;
  if (aspect === "1:1") return 1;
  return 16 / 10;
}

function aspectClassName(aspect: ProductCropAspect): string {
  if (aspect === "4:3") return "aspect-[4/3]";
  if (aspect === "1:1") return "aspect-square";
  return "aspect-[16/10]";
}

function supportedImageMime(type: string): string {
  return type === "image/png" || type === "image/webp" || type === "image/jpeg" ? type : "image/jpeg";
}

function croppedFilename(filename: string, mimeType: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || "product-image";
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `${base}-cropped.${ext}`;
}

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

function ProductImageSliderEditor({
  value,
  coverAssetId,
  onChange,
  onUseAsCover,
  language,
}: {
  value: Record<string, unknown>[];
  coverAssetId: string;
  onChange: (value: Record<string, unknown>[]) => void;
  onUseAsCover: (assetId: string) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const update = (index: number, field: string, nextValue: unknown): void => {
    const next = value.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: nextValue } : item);
    onChange(next);
  };
  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  };
  return (
    <div className="mt-5 rounded-lg border border-[var(--glass-border)] bg-background/40 p-4">
      <SectionTitle
        title={t(language, "entryEdit.productSlides")}
        body={t(language, "entryEdit.productSlidesBody")}
      />
      <div className="space-y-3">
        {value.map((item, index) => {
          const assetId = stringForInput(item["assetId"]);
          return (
            <div key={index} className="rounded-md border border-[var(--glass-border)] bg-background/45 p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="label-eyebrow">{t(language, "entryEdit.slideNumber", { number: String(index + 1) })}</p>
                  {assetId && assetId === coverAssetId ? (
                    <span className="mt-1 inline-flex rounded-full bg-primary/12 px-2 py-0.5 text-xs font-semibold text-primary">
                      {t(language, "entryEdit.coverSlide")}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="row-action"
                    title={t(language, "entryEdit.moveItemUp")}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    title={t(language, "entryEdit.moveItemDown")}
                    disabled={index === value.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="row-action row-action-label"
                    title={t(language, "entryEdit.useAsCover")}
                    disabled={!assetId || assetId === coverAssetId}
                    onClick={() => onUseAsCover(assetId)}
                  >
                    <ImagePlus className="size-3.5" aria-hidden />
                    <span>{t(language, "entryEdit.useAsCover")}</span>
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    title={t(language, "entryEdit.removeItem")}
                    onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <FieldShell label={t(language, "entryEdit.coverAsset")}>
                  <input
                    className="admin-input"
                    value={assetId}
                    onChange={(event) => update(index, "assetId", event.target.value)}
                    placeholder="media asset id"
                  />
                </FieldShell>
                <FieldShell label={t(language, "entryEdit.coverAlt")}>
                  <input
                    className="admin-input"
                    value={stringForInput(item["alt"])}
                    onChange={(event) => update(index, "alt", event.target.value)}
                  />
                </FieldShell>
              </div>
            </div>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...value, { assetId: "", alt: "" }])}
        >
          <Plus className="size-3.5" aria-hidden />
          {t(language, "entryEdit.addProductSlide")}
        </Button>
      </div>
    </div>
  );
}

function ProductSkuEntryFields({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  return (
    <>
      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.skus")}
          body={t(language, "entryEdit.skuInlineHint")}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label={t(language, "entryEdit.skuCode")} required>
            <input className="admin-input" value={stringForInput(value["skuCode"])} onChange={(event) => setField("skuCode", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.productSlug")}>
            <input className="admin-input" value={stringForInput(value["productSlug"])} onChange={(event) => setField("productSlug", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.priceMinor")} required>
            <input className="admin-input" type="number" min={0} value={numberForInput(value["priceMinor"])} onChange={(event) => setField("priceMinor", numberInputValue(event.target.value))} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.compareAtPriceMinor")}>
            <input className="admin-input" type="number" min={0} value={numberForInput(value["compareAtPriceMinor"])} onChange={(event) => setField("compareAtPriceMinor", numberInputValue(event.target.value))} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.inventoryMode")}>
            <select className="admin-input" value={stringForInput(value["inventoryMode"])} onChange={(event) => setField("inventoryMode", event.target.value)}>
              <option value="tracked">{t(language, "entryEdit.inventoryTracked")}</option>
              <option value="untracked">{t(language, "entryEdit.inventoryUntracked")}</option>
            </select>
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.currency")}>
            <input className="admin-input" value={stringForInput(value["currency"])} onChange={(event) => setField("currency", event.target.value.toUpperCase())} />
          </FieldShell>
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.optionValues")}
          body={t(language, "entryEdit.optionValuesBody")}
        />
        <JsonEditor value={objectValue(value["optionValues"])} onChange={(next) => setField("optionValues", next)} />
      </SectionCard>

      <StructuredListEditor
        title={t(language, "entryEdit.productVisual")}
        body={t(language, "entryEdit.productVisualBody")}
        addLabel={t(language, "entryEdit.addItem")}
        value={recordArray(value["images"])}
        onChange={(next) => setField("images", next)}
        language={language}
        emptyItem={{ assetId: "", alt: "" }}
        fields={[
          { name: "assetId", label: t(language, "entryEdit.assetId") },
          { name: "alt", label: t(language, "entryEdit.imageAlt") },
        ]}
        icon={<ImagePlus className="size-4" aria-hidden />}
      />
    </>
  );
}

function ProductTranslationEntryFields({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const defaultSettings = useQuery<SiteSettings>({
    queryKey: ["site-settings"],
    queryFn: () => api.get<SiteSettings>("/site-settings"),
  });
  const didApplyDefaults = React.useRef(false);
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  React.useEffect(() => {
    if (didApplyDefaults.current || !defaultSettings.data) return;
    const next = applyBrandDefaultsToEntryData(value, defaultSettings.data);
    if (next === value) return;
    didApplyDefaults.current = true;
    onChange(next);
  }, [defaultSettings.data, onChange, value]);
  return (
    <>
      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.productInfo")}
          body={t(language, "entryEdit.productInfoBody")}
          action={<SectionPreviewButton language={language} kind="productInfo" />}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label={t(language, "collection.table.locale")}>
            <input className="admin-input" value={stringForInput(value["locale"])} onChange={(event) => setField("locale", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.title")} required>
            <input className="admin-input" value={stringForInput(value["title"])} onChange={(event) => setField("title", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.coverAlt")}>
            <input className="admin-input" value={stringForInput(value["coverAlt"])} onChange={(event) => setField("coverAlt", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.shortDescription")}>
            <input className="admin-input" value={stringForInput(value["shortDescription"])} onChange={(event) => setField("shortDescription", event.target.value)} />
          </FieldShell>
        </div>
        <div className="mt-4">
          <FieldShell label={t(language, "entryEdit.bodyMarkdown")}>
            <RichTextEditor compact value={stringForInput(value["body"])} onChange={(next) => setField("body", next)} />
          </FieldShell>
        </div>
      </SectionCard>
      <MerchandisingEditor
        value={objectValue(value["merchandising"])}
        onChange={(next) => setField("merchandising", next)}
        language={language}
      />
    </>
  );
}

function applyBrandDefaultsToEntryData(
  value: Record<string, unknown>,
  settings: SiteSettings,
): Record<string, unknown> {
  const merchandising = objectValue(value["merchandising"]);
  const brand = objectValue(merchandising["brand"]);
  if (hasBrandContent(brand)) return value;
  const defaultBrand = brandDefaultsFromSettings(settings);
  if (!hasBrandContent(defaultBrand)) return value;
  return {
    ...value,
    merchandising: {
      ...merchandising,
      brand: {
        ...brand,
        ...defaultBrand,
      },
    },
  };
}

function brandDefaultsFromSettings(settings: SiteSettings | undefined): Record<string, unknown> {
  if (!settings) return {};
  return {
    name: settings.brand,
    tagline: settings.description,
    intro: settings.brandIntro,
  };
}

function hasBrandContent(brand: Record<string, unknown>): boolean {
  return ["name", "tagline", "intro"].some((field) => stringForInput(brand[field]).trim().length > 0);
}

function PageTranslationEntryFields({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  return (
    <SectionCard>
      <SectionTitle
        title={t(language, "entryEdit.pageContent")}
        body={t(language, "entryEdit.pageContentBody")}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label={t(language, "collection.table.locale")}>
          <input className="admin-input" value={stringForInput(value["locale"])} onChange={(event) => setField("locale", event.target.value)} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.title")} required>
          <input className="admin-input" value={stringForInput(value["title"])} onChange={(event) => setField("title", event.target.value)} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.slug")} required>
          <input className="admin-input" value={stringForInput(value["slug"])} onChange={(event) => setField("slug", event.target.value)} />
        </FieldShell>
      </div>
      <div className="mt-4">
        <FieldShell label={t(language, "entryEdit.summary")}>
          <textarea className="admin-textarea admin-textarea-compact" value={stringForInput(value["summary"])} onChange={(event) => setField("summary", event.target.value)} />
        </FieldShell>
      </div>
      <div className="mt-4">
        <FieldShell label={t(language, "entryEdit.bodyMarkdown")}>
          <RichTextEditor compact value={stringForInput(value["body"])} onChange={(next) => setField("body", next)} />
        </FieldShell>
      </div>
      <PageBlocksEditor
        value={recordArray(value["blocks"])}
        onChange={(next) => setField("blocks", next)}
        language={language}
      />
    </SectionCard>
  );
}

function OrderManagementFields({
  value,
  onChange,
  language,
  showEmbeddedItems = true,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
  showEmbeddedItems?: boolean;
}): React.ReactElement {
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  const shippingAddress = objectValue(value["shippingAddress"]);
  const marketingAttribution = objectValue(value["marketingAttribution"]);
  const setShippingField = (field: string, next: unknown): void => {
    setField("shippingAddress", { ...shippingAddress, [field]: next });
  };
  const setAttributionField = (field: string, next: unknown): void => {
    setField("marketingAttribution", { ...marketingAttribution, [field]: next });
  };

  return (
    <>
      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.orderWorkflow")}
          body={t(language, "entryEdit.orderWorkflowBody")}
        />
        <div className="grid gap-4 md:grid-cols-3">
          <FieldShell label={t(language, "entryEdit.orderNumber")}>
            <input className="admin-input" value={stringForInput(value["orderNumber"])} onChange={(event) => setField("orderNumber", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.orderStatus")}>
            <select className="admin-input" value={stringForInput(value["orderStatus"])} onChange={(event) => setField("orderStatus", event.target.value)}>
              {["placed", "fulfilling", "shipped", "completed", "cancelled", "refunded"].map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.currency")}>
            <input className="admin-input" value={stringForInput(value["currency"])} onChange={(event) => setField("currency", event.target.value.toUpperCase())} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.placedAt")}>
            <input className="admin-input" type="datetime-local" value={datetimeForInput(value["placedAt"])} onChange={(event) => setField("placedAt", dateTimeInputMs(event.target.value))} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.fulfilledAt")}>
            <input className="admin-input" type="datetime-local" value={datetimeForInput(value["fulfilledAt"])} onChange={(event) => setField("fulfilledAt", dateTimeInputMs(event.target.value))} />
          </FieldShell>
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.orderMoney")}
          body={t(language, "entryEdit.orderMoneyBody")}
        />
        <div className="grid gap-4 md:grid-cols-4">
          {[
            ["subtotalMinor", t(language, "entryEdit.subtotalMinor")],
            ["discountMinor", t(language, "entryEdit.discountMinor")],
            ["shippingMinor", t(language, "entryEdit.shippingMinor")],
            ["totalMinor", t(language, "entryEdit.totalMinor")],
          ].map(([field, label]) => (
            <FieldShell key={field} label={label}>
              <input className="admin-input" type="number" value={numberForInput(value[field])} onChange={(event) => setField(field, numberInputValue(event.target.value))} />
            </FieldShell>
          ))}
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.orderCustomer")}
          body={t(language, "entryEdit.orderCustomerBody")}
        />
        <div className="grid gap-4 md:grid-cols-3">
          <FieldShell label={t(language, "entryEdit.customerName")}>
            <input className="admin-input" value={stringForInput(value["customerName"])} onChange={(event) => setField("customerName", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.customerEmail")}>
            <input className="admin-input" type="email" value={stringForInput(value["customerEmail"])} onChange={(event) => setField("customerEmail", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.userId")}>
            <input className="admin-input" value={stringForInput(value["userId"])} onChange={(event) => setField("userId", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.paymentProvider")}>
            <input className="admin-input" value={stringForInput(value["paymentProvider"])} onChange={(event) => setField("paymentProvider", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.paymentIntentId")}>
            <input className="admin-input" value={stringForInput(value["paymentIntentId"])} onChange={(event) => setField("paymentIntentId", event.target.value)} />
          </FieldShell>
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.shippingAddress")}
          body={t(language, "entryEdit.shippingAddressBody")}
        />
        <div className="grid gap-4 md:grid-cols-3">
          {["name", "phone", "line1", "line2", "city", "region", "postalCode", "country"].map((field) => (
            <FieldShell key={field} label={fieldLabel(field)}>
              <input className="admin-input" value={stringForInput(shippingAddress[field])} onChange={(event) => setShippingField(field, event.target.value)} />
            </FieldShell>
          ))}
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.marketingAttribution")}
          body={t(language, "entryEdit.marketingAttributionBody")}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label={t(language, "entryEdit.promoCode")}>
            <input className="admin-input" value={stringForInput(marketingAttribution["promoCode"])} onChange={(event) => setAttributionField("promoCode", event.target.value)} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.specialLinkCode")}>
            <input className="admin-input" value={stringForInput(marketingAttribution["specialLinkCode"])} onChange={(event) => setAttributionField("specialLinkCode", event.target.value)} />
          </FieldShell>
        </div>
      </SectionCard>

      {showEmbeddedItems ? (
        <StructuredListEditor
          title={t(language, "entryEdit.orderItems")}
          body={t(language, "entryEdit.orderItemsBody")}
          addLabel={t(language, "entryEdit.addOrderItem")}
          value={recordArray(value["items"])}
          onChange={(next) => setField("items", next)}
          language={language}
          emptyItem={{ skuCode: "", productSlug: "", qty: 1, priceMinorAtPurchase: 0, title: "", imageAssetId: "" }}
          fields={[
            { name: "title", label: t(language, "entryEdit.title") },
            { name: "skuCode", label: t(language, "entryEdit.skuCode") },
            { name: "productSlug", label: t(language, "entryEdit.productSlug") },
            { name: "qty", label: t(language, "entryEdit.quantity"), kind: "number" },
            { name: "priceMinorAtPurchase", label: t(language, "entryEdit.priceMinor"), kind: "number" },
            { name: "imageAssetId", label: t(language, "entryEdit.coverAsset") },
          ]}
        />
      ) : null}

      <StructuredListEditor
        title={t(language, "entryEdit.orderDiscounts")}
        body={t(language, "entryEdit.orderDiscountsBody")}
        addLabel={t(language, "entryEdit.addOrderDiscount")}
        value={recordArray(value["discounts"])}
        onChange={(next) => setField("discounts", next)}
        language={language}
        emptyItem={{ kind: "", label: "", title: "", code: "", productSlug: "", skuCode: "", relatedSkuCode: "", discountPercent: null, discountMinor: null }}
        fields={[
          { name: "kind", label: t(language, "entryEdit.discountKind") },
          { name: "label", label: t(language, "entryEdit.promoLabel") },
          { name: "title", label: t(language, "entryEdit.campaignTitle") },
          { name: "code", label: t(language, "entryEdit.campaignCode") },
          { name: "productSlug", label: t(language, "entryEdit.productSlug") },
          { name: "skuCode", label: t(language, "entryEdit.skuCode") },
          { name: "relatedSkuCode", label: t(language, "entryEdit.relatedSkuCode") },
          { name: "discountPercent", label: t(language, "entryEdit.discountPercent"), kind: "number" },
          { name: "discountMinor", label: t(language, "entryEdit.discountMinor"), kind: "number" },
        ]}
      />
    </>
  );
}

function OrderLineItemsSection({
  section,
  language,
  onSaved,
}: {
  section: RelatedEntrySection;
  language: AdminLanguage;
  onSaved?: () => void;
}): React.ReactElement {
  return (
    <SectionCard>
      <SectionTitle
        title={t(language, "entryEdit.orderItems")}
        body={t(language, "entryEdit.orderItemsBody")}
      />
      {section.entries.length === 0 ? (
        <CreateRelatedEntryPrompt
          section={section}
          language={language}
          label={t(language, "entryEdit.addOrderItem")}
          seedData={{
            title: "",
            skuCode: "",
            productSlug: "",
            variantLabel: "",
            qty: 1,
            priceMinorAtPurchase: 0,
            lineTotalMinor: 0,
            imageAssetId: "",
          }}
          onSaved={onSaved}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--glass-border)] bg-background/35">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-[var(--glass-border)] bg-background/55 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t(language, "entryEdit.title")}</th>
                <th className="px-4 py-3">{t(language, "entryEdit.skuCode")}</th>
                <th className="px-4 py-3">{t(language, "entryEdit.quantity")}</th>
                <th className="px-4 py-3">{t(language, "entryEdit.priceMinorAtPurchase")}</th>
                <th className="px-4 py-3">{t(language, "entryEdit.lineTotalMinor")}</th>
                <th className="px-4 py-3 text-right">{t(language, "collection.table.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--glass-border)]">
              {section.entries.map((entry) => (
                <tr key={entry.id} className="transition hover:bg-accent/60">
                  <td className="px-4 py-3">
                    <span className="block font-semibold text-foreground">
                      {stringForInput(entry.data["title"]) || entryTitle(entry.data, entry.id)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {stringForInput(entry.data["variantLabel"]) || stringForInput(entry.data["productSlug"]) || "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {stringForInput(entry.data["skuCode"]) || "-"}
                  </td>
                  <td className="px-4 py-3">{numberForInput(entry.data["qty"]) || "-"}</td>
                  <td className="px-4 py-3">{numberForInput(entry.data["priceMinorAtPurchase"]) || "-"}</td>
                  <td className="px-4 py-3 font-semibold">
                    {numberForInput(entry.data["lineTotalMinor"]) || String(numericValue(entry.data["qty"]) * numericValue(entry.data["priceMinorAtPurchase"]))}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <a
                        className="row-action row-action-label"
                        title={t(language, "entryEdit.openAdvanced")}
                        href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
                      >
                        <ExternalLink className="size-3.5" aria-hidden />
                        <span>{t(language, "entryEdit.openAdvanced")}</span>
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function OrderLineItemFields({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const qty = numericValue(value["qty"]);
  const unitPrice = numericValue(value["priceMinorAtPurchase"]);
  const computedLineTotal = qty * unitPrice;
  const setField = (field: string, next: unknown): void => {
    const nextData = { ...value, [field]: next };
    if (field === "qty" || field === "priceMinorAtPurchase") {
      const nextQty = field === "qty" ? numericValue(next) : numericValue(value["qty"]);
      const nextUnitPrice = field === "priceMinorAtPurchase" ? numericValue(next) : numericValue(value["priceMinorAtPurchase"]);
      nextData["lineTotalMinor"] = nextQty * nextUnitPrice;
    }
    onChange(nextData);
  };
  const orderNumber = stringForInput(value["orderNumber"]);
  const productSlug = stringForInput(value["productSlug"]);

  return (
    <>
      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.orderItemOrder")}
          body={t(language, "entryEdit.orderItemOrderBody")}
        />
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <FieldShell label={t(language, "entryEdit.orderNumber")} required>
            <input
              className="admin-input"
              value={orderNumber}
              onChange={(event) => setField("orderNumber", event.target.value)}
            />
          </FieldShell>
          <Button asChild variant="secondary" className="w-full md:w-auto">
            <a href={`/admin/c/orders${orderNumber ? `?search=${encodeURIComponent(orderNumber)}` : ""}`}>
              <ExternalLink className="size-4" aria-hidden />
              {t(language, "entryEdit.openOrder")}
            </a>
          </Button>
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.orderItemSnapshot")}
          body={t(language, "entryEdit.orderItemSnapshotBody")}
        />
        <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <div className="relative min-h-44 overflow-hidden rounded-lg border border-[var(--glass-border)] bg-[linear-gradient(135deg,#e2e8f0,#c9d8d2_54%,#214b46)]">
            {stringForInput(value["imageAssetId"]) ? (
              <div className="absolute inset-4 grid place-items-center rounded-md border border-white/35 bg-white/30 p-3 text-center text-xs font-semibold text-foreground backdrop-blur-md">
                {stringForInput(value["imageAssetId"])}
              </div>
            ) : (
              <div className="absolute inset-4 grid place-items-center rounded-md border border-white/35 bg-white/30 text-center backdrop-blur-md">
                <PackageCheck className="mb-2 size-7 text-primary" aria-hidden />
                <span className="text-sm font-semibold">{t(language, "entryEdit.orderItemSnapshotEmpty")}</span>
              </div>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldShell label={t(language, "entryEdit.title")}>
              <input className="admin-input" value={stringForInput(value["title"])} onChange={(event) => setField("title", event.target.value)} />
            </FieldShell>
            <FieldShell label={t(language, "entryEdit.variantLabel")}>
              <input className="admin-input" value={stringForInput(value["variantLabel"])} onChange={(event) => setField("variantLabel", event.target.value)} />
            </FieldShell>
            <FieldShell label={t(language, "entryEdit.productSlug")}>
              <input className="admin-input" value={productSlug} onChange={(event) => setField("productSlug", event.target.value)} />
            </FieldShell>
            <FieldShell label={t(language, "entryEdit.skuCode")} required>
              <input className="admin-input" value={stringForInput(value["skuCode"])} onChange={(event) => setField("skuCode", event.target.value)} />
            </FieldShell>
            <FieldShell label={t(language, "entryEdit.coverAsset")}>
              <input className="admin-input" value={stringForInput(value["imageAssetId"])} onChange={(event) => setField("imageAssetId", event.target.value)} />
            </FieldShell>
            <div className="flex items-end">
              <Button asChild variant="secondary" className="w-full">
                <a href={`/admin/c/products${productSlug ? `?search=${encodeURIComponent(productSlug)}` : ""}`}>
                  <ExternalLink className="size-4" aria-hidden />
                  {t(language, "entryEdit.openProduct")}
                </a>
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <SectionTitle
          title={t(language, "entryEdit.orderItemMoney")}
          body={t(language, "entryEdit.orderItemMoneyBody")}
        />
        <div className="grid gap-4 md:grid-cols-3">
          <FieldShell label={t(language, "entryEdit.quantity")} required>
            <input className="admin-input" type="number" min={0} value={numberForInput(value["qty"])} onChange={(event) => setField("qty", numberInputValue(event.target.value))} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.priceMinorAtPurchase")} required>
            <input className="admin-input" type="number" min={0} value={numberForInput(value["priceMinorAtPurchase"])} onChange={(event) => setField("priceMinorAtPurchase", numberInputValue(event.target.value))} />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.lineTotalMinor")}>
            <input className="admin-input" type="number" value={numberForInput(value["lineTotalMinor"])} onChange={(event) => setField("lineTotalMinor", numberInputValue(event.target.value))} />
          </FieldShell>
        </div>
        <div className="mt-4 rounded-lg border border-[var(--glass-border)] bg-background/45 p-4">
          <p className="label-eyebrow">{t(language, "entryEdit.orderItemComputedTotal")}</p>
          <p className="mt-1 text-2xl font-semibold">{computedLineTotal}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t(language, "entryEdit.orderItemComputedTotalBody")}</p>
        </div>
      </SectionCard>
    </>
  );
}

function InventorySnapshotFields({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  return (
    <SectionCard>
      <SectionTitle
        title={t(language, "entryEdit.inventorySnapshot")}
        body={t(language, "entryEdit.inventorySnapshotBody")}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label={t(language, "entryEdit.skuCode")} required>
          <input className="admin-input" value={stringForInput(value["skuCode"])} onChange={(event) => setField("skuCode", event.target.value)} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.available")}>
          <input className="admin-input" type="number" value={numberForInput(value["available"])} onChange={(event) => setField("available", numberInputValue(event.target.value))} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.reserved")}>
          <input className="admin-input" type="number" value={numberForInput(value["reserved"])} onChange={(event) => setField("reserved", numberInputValue(event.target.value))} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.restockedAt")}>
          <input className="admin-input" type="datetime-local" value={datetimeForInput(value["restockedAt"])} onChange={(event) => setField("restockedAt", dateTimeInputMs(event.target.value))} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.updatedAt")}>
          <input className="admin-input" type="datetime-local" value={datetimeForInput(value["updatedAt"])} onChange={(event) => setField("updatedAt", dateTimeInputMs(event.target.value))} />
        </FieldShell>
      </div>
    </SectionCard>
  );
}

function FieldShell({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="block space-y-2">
      <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </span>
      {hint ? <span className="block text-xs leading-5 text-muted-foreground">{hint}</span> : null}
      {children}
    </div>
  );
}

function CopyValueButton({
  value,
  language,
}: {
  value: string;
  language: AdminLanguage;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!value}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {t(language, "common.copy")}
    </Button>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}

function SchemaFields({
  schema,
  value,
  path,
  onChange,
  language,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: string[];
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return (
    <div className="space-y-5">
      {Object.entries(properties).map(([name, fieldSchema]) => (
        <SchemaField
          key={[...path, name].join(".")}
          name={name}
          schema={fieldSchema}
          required={required.has(name)}
          value={readPath(value, [...path, name])}
          path={[...path, name]}
          rootValue={value}
          onChange={onChange}
          language={language}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  required,
  value,
  path,
  rootValue,
  onChange,
  language,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  path: string[];
  rootValue: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const type = schemaType(schema);
  const label = fieldLabel(name);
  const description = friendlyDescription(typeof schema.description === "string" ? schema.description : undefined);
  const setValue = (next: unknown): void => onChange(writePath(rootValue, path, next));

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 text-sm font-semibold text-foreground">
        <span>
          {label}
          {required ? <span className="ml-1 text-destructive">*</span> : null}
        </span>
        {schema["x-mcp-hint"] ? (
          <span className="badge-status bg-accent text-accent-foreground" title={String(schema["x-mcp-hint"])}>
            {String(schema["x-mcp-hint"])}
          </span>
        ) : null}
      </label>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {schema.enum ? (
        <select
          className="admin-input"
          value={stringForInput(value)}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">{t(language, "entryEdit.emptyOption")}</option>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : type === "boolean" ? (
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={Boolean(value)}
            onChange={(event) => setValue(event.target.checked)}
          />
          {t(language, "entryEdit.boolean")}
        </label>
      ) : type === "number" || type === "integer" ? (
        <input
          className="admin-input"
          type="number"
          value={numberForInput(value)}
          min={schema.minimum}
          max={schema.maximum}
          onChange={(event) => {
            const raw = event.target.value;
            setValue(raw === "" ? null : Number(raw));
          }}
        />
      ) : type === "object" ? (
        <div className="rounded-lg border border-[var(--glass-border)] bg-background/30 p-4">
          {schema.properties ? (
            <SchemaFields
              schema={schema}
              value={rootValue}
              path={path}
              onChange={onChange}
              language={language}
            />
          ) : (
            <JsonEditor value={value} onChange={setValue} />
          )}
        </div>
      ) : type === "array" ? (
        <ArrayField
          schema={schema}
          value={Array.isArray(value) ? value : []}
          path={path}
          rootValue={rootValue}
          onChange={onChange}
          language={language}
        />
      ) : multilineField(schema, name) ? (
        <RichTextEditor
          compact
          value={stringForInput(value)}
          onChange={setValue}
        />
      ) : (
        <input
          className="admin-input"
          type={schema.format === "date-time" ? "datetime-local" : "text"}
          value={stringForInput(value)}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
    </div>
  );
}

function ArrayField({
  schema,
  value,
  path,
  rootValue,
  onChange,
  language,
}: {
  schema: JsonSchema;
  value: unknown[];
  path: string[];
  rootValue: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const itemSchema = schema.items ?? {};
  const setArray = (next: unknown[]): void => onChange(writePath(rootValue, path, next));
  return (
    <div className="space-y-3 rounded-lg border border-[var(--glass-border)] bg-background/30 p-3">
      {value.map((item, index) => (
        <div key={index} className="rounded-lg border border-border/70 bg-card/50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground">#{index + 1}</span>
            <button
              type="button"
              className="row-action"
              title={t(language, "entryEdit.removeItem")}
              onClick={() => setArray(value.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
          {schemaType(itemSchema) === "object" && itemSchema.properties ? (
            <SchemaFields
              schema={itemSchema}
              value={rootValue}
              path={[...path, String(index)]}
              onChange={onChange}
              language={language}
            />
          ) : (
            <input
              className="admin-input"
              value={stringForInput(item)}
              onChange={(event) => {
                const next = [...value];
                next[index] = event.target.value;
                setArray(next);
              }}
            />
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setArray([...value, defaultValueForSchema(itemSchema)])}
      >
        <Plus className="size-3.5" aria-hidden />
        {t(language, "entryEdit.addItem")}
      </Button>
    </div>
  );
}

function JsonEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDraft(JSON.stringify(value ?? {}, null, 2));
  }, [value]);
  return (
    <div className="space-y-2">
      <textarea
        className="admin-textarea admin-textarea-compact font-mono"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            onChange(JSON.parse(next) as unknown);
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function RelatedSections({
  sections,
  language,
  parentTitle,
  onSaved,
}: {
  sections: RelatedEntrySection[];
  language: AdminLanguage;
  parentTitle: string;
  onSaved?: () => void;
}): React.ReactElement {
  if (sections.length === 0) {
    return (
      <SectionCard>
        <SectionTitle title={t(language, "entryEdit.related")} body={t(language, "entryEdit.noRelated")} />
      </SectionCard>
    );
  }
  return (
    <>
      {sections.map((section) => (
        section.collection.name === "product-skus" ? (
          <ProductSkuSection
            key={`${section.collection.name}:${section.relationship.childField}`}
            section={section}
            language={language}
            parentTitle={parentTitle}
            onSaved={onSaved}
          />
        ) : section.collection.name === "product-translations" ? (
          <ProductTranslationSection
            key={`${section.collection.name}:${section.relationship.childField}`}
            section={section}
            language={language}
            onSaved={onSaved}
          />
        ) : section.collection.name === "page-translations" ? (
          <PageTranslationSection
            key={`${section.collection.name}:${section.relationship.childField}`}
            section={section}
            language={language}
            onSaved={onSaved}
          />
        ) : (
          <SectionCard key={`${section.collection.name}:${section.relationship.childField}`}>
            <SectionTitle
              title={collectionTitle(section.collection, language)}
              body={t(language, "entryEdit.relationship", {
                child: section.relationship.childField,
                parent: section.relationship.parentField,
              })}
            />
            <div className="space-y-2">
              {section.entries.length === 0 ? (
                <CreateRelatedEntryPrompt
                  section={section}
                  language={language}
                  label={t(language, "entryEdit.createRelated", {
                    name: collectionTitle(section.collection, language),
                  })}
                  onSaved={onSaved}
                />
              ) : (
                section.entries.map((entry) => (
                  <a
                    key={entry.id}
                    href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--glass-border)] bg-background/35 p-3 text-sm text-foreground transition hover:border-primary hover:bg-accent"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{entryTitle(entry.data, entry.id)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {entry.collection} / v{entry.version}
                      </span>
                    </span>
                    <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </a>
                ))
              )}
            </div>
          </SectionCard>
        )
      ))}
    </>
  );
}

function ProductTranslationSection({
  section,
  language,
  onSaved,
}: {
  section: RelatedEntrySection;
  language: AdminLanguage;
  onSaved?: () => void;
}): React.ReactElement {
  const defaultSettings = useQuery<SiteSettings>({
    queryKey: ["site-settings"],
    queryFn: () => api.get<SiteSettings>("/site-settings"),
  });
  return (
    <SectionCard>
      <SectionTitle
        title={t(language, "entryEdit.productInfo")}
        body={t(language, "entryEdit.productInfoBody")}
        action={<SectionPreviewButton language={language} kind="productInfo" />}
      />
      {section.entries.length === 0 ? (
        <CreateRelatedEntryPrompt
          section={section}
          language={language}
          label={t(language, "entryEdit.createProductInfo")}
          seedData={{
            locale: language,
            title: "",
            shortDescription: "",
            body: "",
            coverAlt: "",
            merchandising: {
              brand: brandDefaultsFromSettings(defaultSettings.data),
            },
          }}
          onSaved={onSaved}
        />
      ) : (
        <div className="space-y-4">
          {section.entries.map((entry) => (
            <ProductTranslationCard
              key={entry.id}
              entry={entry}
              language={language}
              onSaved={onSaved}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ProductTranslationCard({
  entry,
  language,
  onSaved,
}: {
  entry: RelatedEntrySection["entries"][number];
  language: AdminLanguage;
  onSaved?: () => void;
}): React.ReactElement {
  const defaultSettings = useQuery<SiteSettings>({
    queryKey: ["site-settings"],
    queryFn: () => api.get<SiteSettings>("/site-settings"),
  });
  const didApplyDefaults = React.useRef(false);
  const [draft, setDraft] = React.useState<Record<string, unknown>>(entry.data);
  React.useEffect(() => setDraft(entry.data), [entry.data]);
  React.useEffect(() => {
    if (didApplyDefaults.current || !defaultSettings.data) return;
    setDraft((current) => {
      const next = applyBrandDefaultsToEntryData(current, defaultSettings.data);
      if (next !== current) didApplyDefaults.current = true;
      return next;
    });
  }, [defaultSettings.data]);
  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(entry.id)}/editor`, {
        data: nextData,
      }),
    onSuccess: (payload) => {
      setDraft(payload.entry.data);
      onSaved?.();
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(entry.data);
  const setField = (field: string, value: unknown): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  return (
    <div className="rounded-lg border border-[var(--glass-border)] bg-background/35 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-eyebrow">{stringForInput(draft["locale"]) || entry.locale || "-"}</p>
          <h3 className="text-base font-semibold">{stringForInput(draft["title"]) || entryTitle(entry.data, entry.id)}</h3>
        </div>
        <a
          className="row-action"
          title={t(language, "entryEdit.openAdvanced")}
          href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label={t(language, "entryEdit.title")} required>
          <input
            className="admin-input"
            value={stringForInput(draft["title"])}
            onChange={(event) => setField("title", event.target.value)}
          />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.coverAlt")}>
          <input
            className="admin-input"
            value={stringForInput(draft["coverAlt"])}
            onChange={(event) => setField("coverAlt", event.target.value)}
          />
        </FieldShell>
      </div>
      <div className="mt-4">
        <FieldShell label={t(language, "entryEdit.shortDescription")}>
          <input
            className="admin-input"
            value={stringForInput(draft["shortDescription"])}
            onChange={(event) => setField("shortDescription", event.target.value)}
          />
        </FieldShell>
      </div>
      <div className="mt-4">
        <FieldShell label={t(language, "entryEdit.bodyMarkdown")}>
          <RichTextEditor
            compact
            value={stringForInput(draft["body"])}
            onChange={(value) => setField("body", value)}
          />
        </FieldShell>
      </div>
      <MerchandisingEditor
        value={objectValue(draft["merchandising"])}
        onChange={(value) => setField("merchandising", value)}
        language={language}
      />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t(language, "entryEdit.productInfoHint")}</p>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          <Save className="size-3.5" aria-hidden />
          {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
        </Button>
      </div>
      {save.isError ? <p className="mt-2 text-xs text-destructive">{save.error instanceof Error ? save.error.message : String(save.error)}</p> : null}
    </div>
  );
}

function PageTranslationSection({
  section,
  language,
  onSaved,
}: {
  section: RelatedEntrySection;
  language: AdminLanguage;
  onSaved?: () => void;
}): React.ReactElement {
  return (
    <SectionCard>
      <SectionTitle
        title={t(language, "entryEdit.pageContent")}
        body={t(language, "entryEdit.pageContentBody")}
      />
      {section.entries.length === 0 ? (
        <CreateRelatedEntryPrompt
          section={section}
          language={language}
          label={t(language, "entryEdit.createPageContent")}
          seedData={{
            locale: language,
            title: "",
            summary: "",
            body: "",
            blocks: [],
          }}
          onSaved={onSaved}
        />
      ) : (
        <div className="space-y-4">
          {section.entries.map((entry) => (
            <PageTranslationCard key={entry.id} entry={entry} language={language} onSaved={onSaved} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function PageTranslationCard({
  entry,
  language,
  onSaved,
}: {
  entry: RelatedEntrySection["entries"][number];
  language: AdminLanguage;
  onSaved?: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<Record<string, unknown>>(entry.data);
  React.useEffect(() => setDraft(entry.data), [entry.data]);
  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(entry.id)}/editor`, {
        data: nextData,
      }),
    onSuccess: (payload) => {
      setDraft(payload.entry.data);
      onSaved?.();
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(entry.data);
  const setField = (field: string, value: unknown): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <div className="rounded-lg border border-[var(--glass-border)] bg-background/35 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-eyebrow">{stringForInput(draft["locale"]) || entry.locale || "-"}</p>
          <h3 className="text-base font-semibold">{stringForInput(draft["title"]) || entryTitle(entry.data, entry.id)}</h3>
        </div>
        <a
          className="row-action"
          title={t(language, "entryEdit.openAdvanced")}
          href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldShell label={t(language, "entryEdit.title")} required>
          <input className="admin-input" value={stringForInput(draft["title"])} onChange={(event) => setField("title", event.target.value)} />
        </FieldShell>
        <FieldShell label={t(language, "entryEdit.slug")} required>
          <input className="admin-input" value={stringForInput(draft["slug"])} onChange={(event) => setField("slug", event.target.value)} />
        </FieldShell>
      </div>
      <div className="mt-4">
        <FieldShell label={t(language, "entryEdit.summary")}>
          <textarea className="admin-textarea admin-textarea-compact" value={stringForInput(draft["summary"])} onChange={(event) => setField("summary", event.target.value)} />
        </FieldShell>
      </div>
      <div className="mt-4">
        <FieldShell label={t(language, "entryEdit.bodyMarkdown")}>
          <RichTextEditor compact value={stringForInput(draft["body"])} onChange={(value) => setField("body", value)} />
        </FieldShell>
      </div>
      <PageBlocksEditor
        value={recordArray(draft["blocks"])}
        onChange={(blocks) => setField("blocks", blocks)}
        language={language}
      />
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          <Save className="size-3.5" aria-hidden />
          {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
        </Button>
      </div>
      {save.isError ? <p className="mt-2 text-xs text-destructive">{save.error instanceof Error ? save.error.message : String(save.error)}</p> : null}
    </div>
  );
}

type PageBlockType = "hero" | "features" | "prose" | "cta" | "media";

function PageBlocksEditor({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>[];
  onChange: (value: Record<string, unknown>[]) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const updateBlock = (index: number, nextBlock: Record<string, unknown>): void => {
    onChange(value.map((block, itemIndex) => itemIndex === index ? nextBlock : block));
  };
  return (
    <div className="mt-5 rounded-lg border border-[var(--glass-border)] bg-background/40 p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-primary">
          <LayoutTemplate className="size-4" aria-hidden />
        </span>
        <SectionTitle
          title={t(language, "entryEdit.pageBlocks")}
          body={t(language, "entryEdit.pageBlocksBody")}
        />
      </div>
      <div className="space-y-3">
        {value.map((block, index) => (
          <PageBlockCard
            key={index}
            index={index}
            value={block}
            onChange={(next) => updateBlock(index, next)}
            onDelete={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            language={language}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          {(["hero", "features", "prose", "cta", "media"] as const).map((type) => (
            <Button key={type} type="button" variant="secondary" size="sm" onClick={() => onChange([...value, defaultPageBlock(type)])}>
              <Plus className="size-3.5" aria-hidden />
              {pageBlockTypeLabel(language, type)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PageBlockCard({
  index,
  value,
  onChange,
  onDelete,
  language,
}: {
  index: number;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onDelete: () => void;
  language: AdminLanguage;
}): React.ReactElement {
  const type = pageBlockType(value["type"]);
  const setField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  const cards = recordArray(value["cards"]);

  return (
    <div className="rounded-lg border border-border/70 bg-card/45 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">#{index + 1}</span>
          <select className="admin-input h-9 w-40 py-1 text-sm" value={type} onChange={(event) => onChange(defaultPageBlock(event.target.value as PageBlockType, value))}>
            {(["hero", "features", "prose", "cta", "media"] as const).map((option) => (
              <option key={option} value={option}>{pageBlockTypeLabel(language, option)}</option>
            ))}
          </select>
        </div>
        <button type="button" className="row-action" title={t(language, "entryEdit.removeItem")} onClick={onDelete}>
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>

      {type === "hero" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <StructuredFieldInput field={{ name: "eyebrow", label: t(language, "entryEdit.eyebrow") }} value={value["eyebrow"]} onChange={(next) => setField("eyebrow", next)} />
          <StructuredFieldInput field={{ name: "headline", label: t(language, "entryEdit.headline") }} value={value["headline"]} onChange={(next) => setField("headline", next)} />
          <div className="md:col-span-2">
            <StructuredFieldInput field={{ name: "paragraph", label: t(language, "entryEdit.paragraph"), kind: "textarea" }} value={value["paragraph"]} onChange={(next) => setField("paragraph", next)} />
          </div>
          <StructuredFieldInput field={{ name: "imageAssetId", label: t(language, "entryEdit.imageAssetId") }} value={value["imageAssetId"]} onChange={(next) => setField("imageAssetId", next)} />
          <StructuredFieldInput field={{ name: "imageAlt", label: t(language, "entryEdit.imageAlt") }} value={value["imageAlt"]} onChange={(next) => setField("imageAlt", next)} />
        </div>
      ) : null}

      {type === "features" ? (
        <div className="space-y-3">
          <StructuredFieldInput field={{ name: "heading", label: t(language, "entryEdit.heading") }} value={value["heading"]} onChange={(next) => setField("heading", next)} />
          <StructuredListEditor
            title={t(language, "entryEdit.featureCards")}
            body={t(language, "entryEdit.featureCardsBody")}
            addLabel={t(language, "entryEdit.addFeatureCard")}
            value={cards}
            onChange={(next) => setField("cards", next)}
            language={language}
            emptyItem={{ variant: "white", tag: "", title: "", body: "", sideImageAssetId: "", sideImageAlt: "" }}
            fields={[
              { name: "variant", label: t(language, "entryEdit.variant") },
              { name: "tag", label: t(language, "entryEdit.tag") },
              { name: "title", label: t(language, "entryEdit.title") },
              { name: "body", label: t(language, "entryEdit.sectionBody"), kind: "textarea" },
              { name: "sideImageAssetId", label: t(language, "entryEdit.sideImageAssetId") },
              { name: "sideImageAlt", label: t(language, "entryEdit.sideImageAlt") },
            ]}
          />
        </div>
      ) : null}

      {type === "prose" ? (
        <StructuredFieldInput field={{ name: "markdown", label: t(language, "entryEdit.markdown"), kind: "rich" }} value={value["markdown"]} onChange={(next) => setField("markdown", next)} />
      ) : null}

      {type === "cta" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <StructuredFieldInput field={{ name: "heading", label: t(language, "entryEdit.heading") }} value={value["heading"]} onChange={(next) => setField("heading", next)} />
          <StructuredFieldInput field={{ name: "buttonLabel", label: t(language, "entryEdit.buttonLabel") }} value={value["buttonLabel"]} onChange={(next) => setField("buttonLabel", next)} />
          <StructuredFieldInput field={{ name: "buttonHref", label: t(language, "entryEdit.buttonHref") }} value={value["buttonHref"]} onChange={(next) => setField("buttonHref", next)} />
          <div className="md:col-span-2">
            <StructuredFieldInput field={{ name: "body", label: t(language, "entryEdit.sectionBody"), kind: "textarea" }} value={value["body"]} onChange={(next) => setField("body", next)} />
          </div>
        </div>
      ) : null}

      {type === "media" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <StructuredFieldInput field={{ name: "sectionEyebrow", label: t(language, "entryEdit.sectionEyebrow") }} value={value["sectionEyebrow"]} onChange={(next) => setField("sectionEyebrow", next)} />
          <StructuredFieldInput field={{ name: "assetId", label: t(language, "entryEdit.assetId") }} value={value["assetId"]} onChange={(next) => setField("assetId", next)} />
          <StructuredFieldInput field={{ name: "assetAlt", label: t(language, "entryEdit.assetAlt") }} value={value["assetAlt"]} onChange={(next) => setField("assetAlt", next)} />
          <StructuredFieldInput field={{ name: "caption", label: t(language, "media.caption") }} value={value["caption"]} onChange={(next) => setField("caption", next)} />
          <div className="md:col-span-2">
            <StructuredFieldInput field={{ name: "body", label: t(language, "entryEdit.sectionBody"), kind: "textarea" }} value={value["body"]} onChange={(next) => setField("body", next)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function pageBlockType(value: unknown): PageBlockType {
  return value === "features" || value === "prose" || value === "cta" || value === "media" ? value : "hero";
}

function defaultPageBlock(type: PageBlockType, previous: Record<string, unknown> = {}): Record<string, unknown> {
  if (type === "hero") return { type, eyebrow: previous["eyebrow"] ?? "", headline: previous["headline"] ?? "", paragraph: previous["paragraph"] ?? "", imageAssetId: previous["imageAssetId"] ?? "", imageAlt: previous["imageAlt"] ?? "" };
  if (type === "features") return { type, heading: previous["heading"] ?? "", cards: Array.isArray(previous["cards"]) ? previous["cards"] : [] };
  if (type === "prose") return { type, markdown: previous["markdown"] ?? previous["body"] ?? "" };
  if (type === "cta") return { type, heading: previous["heading"] ?? "", body: previous["body"] ?? "", buttonLabel: previous["buttonLabel"] ?? "", buttonHref: previous["buttonHref"] ?? "" };
  return { type, sectionEyebrow: previous["sectionEyebrow"] ?? "", assetId: previous["assetId"] ?? previous["imageAssetId"] ?? "", assetAlt: previous["assetAlt"] ?? previous["imageAlt"] ?? "", caption: previous["caption"] ?? "", body: previous["body"] ?? "" };
}

function pageBlockTypeLabel(language: AdminLanguage, type: PageBlockType): string {
  switch (type) {
    case "hero": return t(language, "entryEdit.blockHero");
    case "features": return t(language, "entryEdit.blockFeatures");
    case "prose": return t(language, "entryEdit.blockProse");
    case "cta": return t(language, "entryEdit.blockCta");
    case "media": return t(language, "entryEdit.blockMedia");
  }
}

function MerchandisingEditor({
  value,
  onChange,
  language,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  language: AdminLanguage;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const siteSettings = useQuery<SiteSettings>({
    queryKey: ["site-settings"],
    queryFn: () => api.get<SiteSettings>("/site-settings"),
  });
  const brand = objectValue(value["brand"]);
  const marketing = objectValue(value["marketing"]);
  const setMerchandisingField = (field: string, next: unknown): void => onChange({ ...value, [field]: next });
  const setBrandField = (field: string, next: unknown): void => {
    setMerchandisingField("brand", { ...brand, [field]: next });
  };
  const setMarketingField = (field: string, next: unknown): void => {
    setMerchandisingField("marketing", { ...marketing, [field]: next });
  };
  const saveBrandDefault = useMutation({
    mutationFn: async () => {
      const current = siteSettings.data ?? await api.get<SiteSettings>("/site-settings");
      return api.patch<SiteSettings>("/site-settings", {
        ...current,
        brand: stringForInput(brand["name"]) || current.brand,
        description: stringForInput(brand["tagline"]) || current.description,
        brandIntro: stringForInput(brand["intro"]),
      });
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(["site-settings"], settings);
    },
  });

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-lg border border-[var(--glass-border)] bg-background/40 p-4">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-primary">
            <Tag className="size-4" aria-hidden />
          </span>
          <SectionTitle
            title={t(language, "entryEdit.merchandising")}
            body={t(language, "entryEdit.merchandisingBody")}
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FieldShell label={t(language, "entryEdit.brandName")}>
            <input
              className="admin-input"
              value={stringForInput(brand["name"])}
              onChange={(event) => setBrandField("name", event.target.value)}
            />
          </FieldShell>
          <FieldShell label={t(language, "entryEdit.brandTagline")}>
            <input
              className="admin-input"
              value={stringForInput(brand["tagline"])}
              onChange={(event) => setBrandField("tagline", event.target.value)}
            />
          </FieldShell>
          <div className="md:col-span-2">
            <FieldShell label={t(language, "entryEdit.brandIntro")}>
              <RichTextEditor
                compact
                value={stringForInput(brand["intro"])}
                onChange={(next) => setBrandField("intro", next)}
              />
            </FieldShell>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--glass-border)] pt-4">
          <p className="text-xs leading-5 text-muted-foreground">
            {saveBrandDefault.isSuccess
              ? t(language, "entryEdit.brandDefaultsSaved")
              : t(language, "entryEdit.brandDefaultsHint")}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={saveBrandDefault.isPending || !hasBrandContent(brand)}
            title={t(language, "entryEdit.saveBrandDefaultsTooltip")}
            onClick={() => saveBrandDefault.mutate()}
          >
            <Save className="size-3.5" aria-hidden />
            {saveBrandDefault.isPending ? t(language, "crud.saving") : t(language, "entryEdit.saveBrandDefaults")}
          </Button>
        </div>
        {saveBrandDefault.isError ? (
          <p className="mt-2 text-xs text-destructive">
            {saveBrandDefault.error instanceof Error ? saveBrandDefault.error.message : String(saveBrandDefault.error)}
          </p>
        ) : null}
      </div>

      <StringListEditor
        title={t(language, "entryEdit.highlights")}
        body={t(language, "entryEdit.highlightsBody")}
        addLabel={t(language, "entryEdit.addHighlight")}
        value={stringArray(value["highlights"])}
        onChange={(next) => setMerchandisingField("highlights", next)}
        language={language}
        previewKind="highlights"
      />

      <StructuredListEditor
        title={t(language, "entryEdit.introSections")}
        body={t(language, "entryEdit.introSectionsBody")}
        addLabel={t(language, "entryEdit.addIntroSection")}
        value={recordArray(value["introSections"])}
        onChange={(next) => setMerchandisingField("introSections", next)}
        language={language}
        emptyItem={{ title: "", body: "" }}
        fields={[
          { name: "title", label: t(language, "entryEdit.sectionTitle") },
          { name: "body", label: t(language, "entryEdit.sectionBody"), kind: "rich" },
        ]}
        previewKind="introSections"
      />

      <StructuredListEditor
        title={t(language, "entryEdit.promotions")}
        body={t(language, "entryEdit.promotionsBody")}
        addLabel={t(language, "entryEdit.addPromotion")}
        value={recordArray(value["promotions"])}
        onChange={(next) => setMerchandisingField("promotions", next)}
        language={language}
        emptyItem={{ label: "", title: "", body: "", relatedSkuCode: "", discountPercent: null }}
        fields={[
          { name: "label", label: t(language, "entryEdit.promoLabel") },
          { name: "title", label: t(language, "entryEdit.promoTitle") },
          { name: "body", label: t(language, "entryEdit.promoBody"), kind: "textarea" },
          { name: "relatedSkuCode", label: t(language, "entryEdit.relatedSkuCode") },
          { name: "discountPercent", label: t(language, "entryEdit.discountPercent"), kind: "number" },
        ]}
        previewKind="promotions"
      />

      <StructuredListEditor
        title={t(language, "entryEdit.shippingDeals")}
        body={t(language, "entryEdit.shippingDealsBody")}
        addLabel={t(language, "entryEdit.addShippingDeal")}
        value={recordArray(value["shippingDeals"])}
        onChange={(next) => setMerchandisingField("shippingDeals", next)}
        language={language}
        emptyItem={{ title: "", body: "" }}
        fields={[
          { name: "title", label: t(language, "entryEdit.sectionTitle") },
          { name: "body", label: t(language, "entryEdit.sectionBody"), kind: "textarea" },
        ]}
        previewKind="purchaseNotes"
      />

      <div className="rounded-lg border border-[var(--glass-border)] bg-background/40 p-4">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-primary">
            <BadgePercent className="size-4" aria-hidden />
          </span>
          <SectionTitle
            title={t(language, "entryEdit.marketingRules")}
            body={t(language, "entryEdit.marketingRulesBody")}
          />
        </div>
        <div className="space-y-4">
          <StructuredListEditor
            title={t(language, "entryEdit.passphrases")}
            body={t(language, "entryEdit.passphrasesBody")}
            addLabel={t(language, "entryEdit.addPassphrase")}
            value={recordArray(marketing["passphrases"])}
            onChange={(next) => setMarketingField("passphrases", next)}
            language={language}
            emptyItem={{ code: "", title: "", body: "", productSlug: "", skuCode: "", discountPercent: null, discountMinor: null }}
            fields={marketingRuleFields(language)}
            icon={<Tag className="size-4" aria-hidden />}
          />
          <StructuredListEditor
            title={t(language, "entryEdit.specialLinks")}
            body={t(language, "entryEdit.specialLinksBody")}
            addLabel={t(language, "entryEdit.addSpecialLink")}
            value={recordArray(marketing["specialLinks"])}
            onChange={(next) => setMarketingField("specialLinks", next)}
            language={language}
            emptyItem={{ code: "", title: "", source: "", productSlug: "", skuCode: "", fixedPriceMinor: null, discountPercent: null, discountMinor: null }}
            fields={[
              { name: "code", label: t(language, "entryEdit.campaignCode") },
              { name: "title", label: t(language, "entryEdit.campaignTitle") },
              { name: "source", label: t(language, "entryEdit.linkSource") },
              { name: "productSlug", label: t(language, "entryEdit.productSlug") },
              { name: "skuCode", label: t(language, "entryEdit.skuCode") },
              { name: "fixedPriceMinor", label: t(language, "entryEdit.fixedPriceMinor"), kind: "number" },
              { name: "discountPercent", label: t(language, "entryEdit.discountPercent"), kind: "number" },
              { name: "discountMinor", label: t(language, "entryEdit.discountMinor"), kind: "number" },
            ]}
            icon={<Link2 className="size-4" aria-hidden />}
          />
          <StructuredListEditor
            title={t(language, "entryEdit.timedCampaigns")}
            body={t(language, "entryEdit.timedCampaignsBody")}
            addLabel={t(language, "entryEdit.addTimedCampaign")}
            value={recordArray(marketing["timedCampaigns"])}
            onChange={(next) => setMarketingField("timedCampaigns", next)}
            language={language}
            emptyItem={{ title: "", body: "", productSlug: "", skuCode: "", startsAt: "", endsAt: "", salePriceMinor: null, discountPercent: null, discountMinor: null }}
            fields={[
              { name: "title", label: t(language, "entryEdit.campaignTitle") },
              { name: "body", label: t(language, "entryEdit.campaignBody"), kind: "textarea" },
              { name: "productSlug", label: t(language, "entryEdit.productSlug") },
              { name: "skuCode", label: t(language, "entryEdit.skuCode") },
              { name: "startsAt", label: t(language, "entryEdit.startsAt"), kind: "datetime" },
              { name: "endsAt", label: t(language, "entryEdit.endsAt"), kind: "datetime" },
              { name: "salePriceMinor", label: t(language, "entryEdit.salePriceMinor"), kind: "number" },
              { name: "discountPercent", label: t(language, "entryEdit.discountPercent"), kind: "number" },
              { name: "discountMinor", label: t(language, "entryEdit.discountMinor"), kind: "number" },
            ]}
            icon={<Clock3 className="size-4" aria-hidden />}
          />
          <StructuredListEditor
            title={t(language, "entryEdit.bundles")}
            body={t(language, "entryEdit.bundlesBody")}
            addLabel={t(language, "entryEdit.addBundle")}
            value={recordArray(marketing["bundles"])}
            onChange={(next) => setMarketingField("bundles", next)}
            language={language}
            emptyItem={{ title: "", body: "", triggerProductSlug: "", triggerSkuCode: "", bundledProductSlug: "", bundledSkuCode: "", discountPercent: null, discountMinor: null }}
            fields={[
              { name: "title", label: t(language, "entryEdit.campaignTitle") },
              { name: "body", label: t(language, "entryEdit.campaignBody"), kind: "textarea" },
              { name: "triggerProductSlug", label: t(language, "entryEdit.triggerProductSlug") },
              { name: "triggerSkuCode", label: t(language, "entryEdit.triggerSkuCode") },
              { name: "bundledProductSlug", label: t(language, "entryEdit.bundledProductSlug") },
              { name: "bundledSkuCode", label: t(language, "entryEdit.bundledSkuCode") },
              { name: "discountPercent", label: t(language, "entryEdit.discountPercent"), kind: "number" },
              { name: "discountMinor", label: t(language, "entryEdit.discountMinor"), kind: "number" },
            ]}
            icon={<PackageCheck className="size-4" aria-hidden />}
          />
        </div>
      </div>
    </div>
  );
}

type StructuredField = {
  name: string;
  label: string;
  kind?: "text" | "number" | "textarea" | "rich" | "datetime";
};

function marketingRuleFields(language: AdminLanguage): StructuredField[] {
  return [
    { name: "code", label: t(language, "entryEdit.campaignCode") },
    { name: "title", label: t(language, "entryEdit.campaignTitle") },
    { name: "body", label: t(language, "entryEdit.campaignBody"), kind: "textarea" },
    { name: "productSlug", label: t(language, "entryEdit.productSlug") },
    { name: "skuCode", label: t(language, "entryEdit.skuCode") },
    { name: "discountPercent", label: t(language, "entryEdit.discountPercent"), kind: "number" },
    { name: "discountMinor", label: t(language, "entryEdit.discountMinor"), kind: "number" },
  ];
}

type ProductSectionPreviewKind =
  | "productInfo"
  | "highlights"
  | "introSections"
  | "promotions"
  | "purchaseNotes";

function SectionPreviewButton({
  language,
  kind,
}: {
  language: AdminLanguage;
  kind: ProductSectionPreviewKind;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 border border-[var(--glass-border)] bg-card text-muted-foreground hover:border-primary hover:text-primary"
        onClick={() => setOpen(true)}
        title={t(language, "entryEdit.previewPosition")}
        aria-label={t(language, "entryEdit.previewPosition")}
      >
        <Info className="size-4" aria-hidden />
      </Button>
      {open ? (
        <ProductSectionPreview
          language={language}
          kind={kind}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ProductSectionPreview({
  language,
  kind,
  onClose,
}: {
  language: AdminLanguage;
  kind: ProductSectionPreviewKind;
  onClose: () => void;
}): React.ReactElement {
  const meta = productPreviewMeta(language, kind);
  const activeClass = (target: ProductSectionPreviewKind): string =>
    target === kind
      ? "product-section-preview-active"
      : "product-section-preview-inactive";
  const highlightKeys: I18nKey[] = [
    "entryEdit.previewHighlight1",
    "entryEdit.previewHighlight2",
    "entryEdit.previewHighlight3",
  ];
  return (
    <div className="rich-editor-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="rich-editor-dialog product-section-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={meta.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="label-eyebrow">{t(language, "entryEdit.previewModalEyebrow")}</p>
            <h2 className="mt-1 text-xl font-semibold">{meta.title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{meta.body}</p>
          </div>
          <button type="button" className="row-action" title={t(language, "guide.close")} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="aspect-[4/3] border border-border bg-[linear-gradient(135deg,#e2e8f0,#b7cec4_54%,#25534e)]" />
              <section className={`border p-4 transition ${activeClass("productInfo")}`}>
                <p className="label-eyebrow">{t(language, "entryEdit.previewProductLabel")}</p>
                <h3 className="mt-2 text-2xl font-semibold">{t(language, "entryEdit.previewProductTitle")}</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{t(language, "entryEdit.previewProductCopy")}</p>
              </section>
            </div>

            <section className={`border p-4 transition ${activeClass("highlights")}`}>
              <h3 className="text-base font-semibold">{t(language, "entryEdit.highlights")}</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {highlightKeys.map((key) => (
                  <div key={key} className="border border-border bg-card p-3 text-sm">
                    {t(language, key)}
                  </div>
                ))}
              </div>
            </section>

            <section className={`border p-4 transition ${activeClass("introSections")}`}>
              <h3 className="text-base font-semibold">{t(language, "entryEdit.introSections")}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{t(language, "entryEdit.previewIntroCopy")}</p>
              <div className="mt-4 h-24 border border-dashed border-border bg-muted" />
            </section>
          </div>

          <aside className="space-y-4">
            <section className={`border p-4 transition ${activeClass("promotions")}`}>
              <p className="label-eyebrow">{t(language, "entryEdit.promotions")}</p>
              <h3 className="mt-2 text-lg font-semibold">{t(language, "entryEdit.previewPromotionTitle")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t(language, "entryEdit.previewPromotionBody")}</p>
            </section>
            <section className="border border-border bg-card p-4">
              <p className="label-eyebrow">CTA</p>
              <div className="mt-3 h-10 bg-primary" />
              <div className="mt-2 h-10 border border-border bg-background" />
            </section>
            <section className={`border p-4 transition ${activeClass("purchaseNotes")}`}>
              <h3 className="text-base font-semibold">{t(language, "entryEdit.previewPurchaseTitle")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t(language, "entryEdit.previewPurchaseBody")}</p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function productPreviewMeta(
  language: AdminLanguage,
  kind: ProductSectionPreviewKind,
): { title: string; body: string } {
  const keys: Record<ProductSectionPreviewKind, { title: I18nKey; body: I18nKey }> = {
    productInfo: {
      title: "entryEdit.previewProductInfoTitle",
      body: "entryEdit.previewProductInfoBody",
    },
    highlights: {
      title: "entryEdit.previewHighlightsTitle",
      body: "entryEdit.previewHighlightsBody",
    },
    introSections: {
      title: "entryEdit.previewIntroSectionsTitle",
      body: "entryEdit.previewIntroSectionsBody",
    },
    promotions: {
      title: "entryEdit.previewPromotionsTitle",
      body: "entryEdit.previewPromotionsBody",
    },
    purchaseNotes: {
      title: "entryEdit.previewPurchaseNotesTitle",
      body: "entryEdit.previewPurchaseNotesBody",
    },
  };
  return {
    title: t(language, keys[kind].title),
    body: t(language, keys[kind].body),
  };
}

function StringListEditor({
  title,
  body,
  addLabel,
  value,
  onChange,
  language,
  previewKind,
}: {
  title: string;
  body: string;
  addLabel: string;
  value: string[];
  onChange: (value: string[]) => void;
  language: AdminLanguage;
  previewKind?: ProductSectionPreviewKind;
}): React.ReactElement {
  const update = (index: number, nextValue: string): void => {
    const next = [...value];
    next[index] = nextValue;
    onChange(next);
  };
  return (
    <div className="rounded-lg border border-[var(--glass-border)] bg-background/40 p-4">
      <SectionTitle
        title={title}
        body={body}
        action={previewKind ? <SectionPreviewButton language={language} kind={previewKind} /> : undefined}
      />
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              className="admin-input"
              value={item}
              onChange={(event) => update(index, event.target.value)}
            />
            <button
              type="button"
              className="row-action"
              title={t(language, "entryEdit.removeItem")}
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...value, ""])}
        >
          <Plus className="size-3.5" aria-hidden />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function StructuredListEditor({
  title,
  body,
  addLabel,
  value,
  onChange,
  language,
  emptyItem,
  fields,
  icon,
  previewKind,
}: {
  title: string;
  body: string;
  addLabel: string;
  value: Record<string, unknown>[];
  onChange: (value: Record<string, unknown>[]) => void;
  language: AdminLanguage;
  emptyItem: Record<string, unknown>;
  fields: StructuredField[];
  icon?: React.ReactNode;
  previewKind?: ProductSectionPreviewKind;
}): React.ReactElement {
  const updateItem = (index: number, field: string, nextValue: unknown): void => {
    const next = value.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: nextValue } : item);
    onChange(next);
  };
  return (
    <div className="rounded-lg border border-[var(--glass-border)] bg-background/40 p-4">
      <div className="flex items-start gap-3">
        {icon ? <span className="mt-1 grid size-8 shrink-0 place-items-center rounded-md bg-accent text-primary">{icon}</span> : null}
        <SectionTitle
          title={title}
          body={body}
          className="min-w-0 flex-1"
          action={previewKind ? <SectionPreviewButton language={language} kind={previewKind} /> : undefined}
        />
      </div>
      <div className="space-y-3">
        {value.map((item, index) => (
          <div key={index} className="rounded-lg border border-border/70 bg-card/45 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">#{index + 1}</span>
              <button
                type="button"
                className="row-action"
                title={t(language, "entryEdit.removeItem")}
                onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {fields.map((field) => (
                <div key={field.name} className={field.kind === "rich" || field.kind === "textarea" ? "md:col-span-2" : undefined}>
                  <StructuredFieldInput
                    field={field}
                    value={item[field.name]}
                    onChange={(next) => updateItem(index, field.name, next)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...value, { ...emptyItem }])}
        >
          <Plus className="size-3.5" aria-hidden />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function StructuredFieldInput({
  field,
  value,
  onChange,
}: {
  field: StructuredField;
  value: unknown;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  return (
    <FieldShell label={field.label}>
      {field.kind === "rich" ? (
        <RichTextEditor
          compact
          value={stringForInput(value)}
          onChange={onChange}
        />
      ) : field.kind === "textarea" ? (
        <textarea
          className="admin-textarea admin-textarea-compact"
          value={stringForInput(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.kind === "number" ? (
        <input
          className="admin-input"
          type="number"
          value={numberForInput(value)}
          onChange={(event) => onChange(numberInputValue(event.target.value))}
        />
      ) : field.kind === "datetime" ? (
        <input
          className="admin-input"
          type="datetime-local"
          value={datetimeForInput(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="admin-input"
          value={stringForInput(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

function ProductSkuSection({
  section,
  language,
  parentTitle,
  onSaved,
}: {
  section: RelatedEntrySection;
  language: AdminLanguage;
  parentTitle: string;
  onSaved?: () => void;
}): React.ReactElement {
  return (
    <SectionCard>
      <SectionTitle
        title={t(language, "entryEdit.skus")}
        body={t(language, "entryEdit.skusBody", { name: parentTitle })}
      />
      {section.entries.length === 0 ? (
        <CreateRelatedEntryPrompt
          section={section}
          language={language}
          label={t(language, "entryEdit.createSku")}
          seedData={{
            skuCode: `${String(section.relationship.parentValue || "SKU").toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-SKU`,
            optionValues: {},
            priceMinor: 0,
            compareAtPriceMinor: null,
            inventoryMode: "tracked",
            images: [],
          }}
          onSaved={onSaved}
        />
      ) : (
        <div className="space-y-3">
          {section.entries.map((entry) => (
            <ProductSkuRow key={entry.id} entry={entry} language={language} onSaved={onSaved} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function CreateRelatedEntryPrompt({
  section,
  language,
  label,
  seedData,
  onSaved,
}: {
  section: RelatedEntrySection;
  language: AdminLanguage;
  label: string;
  seedData?: Record<string, unknown>;
  onSaved?: () => void;
}): React.ReactElement {
  const create = useMutation({
    mutationFn: () =>
      api.post("/entries", {
        collection: section.collection.name,
        locale: language,
        data: {
          ...seedData,
          [section.relationship.childField]: section.relationship.parentValue,
        },
      }),
    onSuccess: () => {
      onSaved?.();
    },
  });

  return (
    <div className="rounded-lg border border-dashed border-[var(--glass-border)] bg-background/30 p-4">
      <p className="text-sm leading-6 text-muted-foreground">
        {t(language, "entryEdit.emptyChildCreateHint")}
      </p>
      <Button
        type="button"
        className="mt-3"
        size="sm"
        disabled={create.isPending}
        onClick={() => create.mutate()}
      >
        <Plus className="size-3.5" aria-hidden />
        {create.isPending ? t(language, "crud.saving") : label}
      </Button>
      {create.isError ? (
        <p className="mt-2 text-xs text-destructive">
          {create.error instanceof Error ? create.error.message : String(create.error)}
        </p>
      ) : null}
    </div>
  );
}

function ProductSkuRow({
  entry,
  language,
  onSaved,
}: {
  entry: RelatedEntrySection["entries"][number];
  language: AdminLanguage;
  onSaved?: () => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<Record<string, unknown>>(entry.data);
  React.useEffect(() => setDraft(entry.data), [entry.data]);
  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(entry.id)}/editor`, {
        data: nextData,
      }),
    onSuccess: (payload) => {
      setDraft(payload.entry.data);
      onSaved?.();
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(entry.data);
  const setField = (field: string, value: unknown): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  return (
    <div className="rounded-lg border border-[var(--glass-border)] bg-background/35 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PackageCheck className="size-4 shrink-0 text-primary" aria-hidden />
            <h3 className="truncate text-sm font-semibold" title={stringForInput(draft["skuCode"])}>
              {stringForInput(draft["skuCode"]) || entryTitle(entry.data, entry.id)}
            </h3>
          </div>
          <OptionValueChecklist value={draft["optionValues"]} />
        </div>
        <a
          className="row-action"
          title={t(language, "entryEdit.openAdvanced")}
          href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-semibold text-muted-foreground">
          <span>{t(language, "entryEdit.priceMinor")}</span>
          <input
            className="admin-input"
            type="number"
            min={0}
            value={numberForInput(draft["priceMinor"])}
            onChange={(event) => setField("priceMinor", numberInputValue(event.target.value))}
          />
        </label>
        <label className="space-y-1 text-xs font-semibold text-muted-foreground">
          <span>{t(language, "entryEdit.compareAtPriceMinor")}</span>
          <input
            className="admin-input"
            type="number"
            min={0}
            value={numberForInput(draft["compareAtPriceMinor"])}
            onChange={(event) => setField("compareAtPriceMinor", numberInputValue(event.target.value))}
          />
        </label>
        <label className="space-y-1 text-xs font-semibold text-muted-foreground">
          <span>{t(language, "entryEdit.inventoryMode")}</span>
          <select
            className="admin-input"
            value={stringForInput(draft["inventoryMode"])}
            onChange={(event) => setField("inventoryMode", event.target.value)}
          >
            <option value="tracked">{t(language, "entryEdit.inventoryTracked")}</option>
            <option value="untracked">{t(language, "entryEdit.inventoryUntracked")}</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-semibold text-muted-foreground">
          <span>{t(language, "entryEdit.currency")}</span>
          <input
            className="admin-input"
            value={stringForInput(draft["currency"])}
            onChange={(event) => setField("currency", event.target.value.toUpperCase())}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(language, "entryEdit.skuInlineHint")}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          <Save className="size-3.5" aria-hidden />
          {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
        </Button>
      </div>
      {save.isError ? <p className="mt-2 text-xs text-destructive">{save.error instanceof Error ? save.error.message : String(save.error)}</p> : null}
    </div>
  );
}

function OptionValueChecklist({
  value,
}: {
  value: unknown;
}): React.ReactElement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item != null && item !== "");
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([key, item]) => (
        <span key={key} className="inline-flex items-center gap-1 rounded-md border border-border bg-card/70 px-2 py-1 text-xs text-muted-foreground">
          <input type="checkbox" checked readOnly className="size-3 accent-[var(--primary)]" />
          <span className="font-medium text-foreground/80">{fieldLabel(key)}</span>
          <span>{stringForInput(item)}</span>
        </span>
      ))}
    </div>
  );
}

function numberInputValue(value: string): number | null {
  return value === "" ? null : Number(value);
}

function numericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parentAdminLink(
  collection: EntryEditorPayload["collection"],
  data: Record<string, unknown>,
): { href: string; label: string } | null {
  if (!collection.parent) return null;
  const parentValue = data[collection.parent.childField];
  if ((typeof parentValue !== "string" && typeof parentValue !== "number") || parentValue === "") return null;
  const searchableParentValue = String(parentValue);
  if (collection.parent.collection === "products") {
    return {
      href: `/admin/c/products?search=${encodeURIComponent(searchableParentValue)}`,
      label: `products / ${searchableParentValue}`,
    };
  }
  if (collection.parent.collection === "orders") {
    return {
      href: `/admin/c/orders?search=${encodeURIComponent(searchableParentValue)}`,
      label: `orders / ${searchableParentValue}`,
    };
  }
  return {
    href: `/admin/c/${encodeURIComponent(collection.parent.collection)}`,
    label: collection.parent.collection,
  };
}

function isPrimaryCommerceSection(section: RelatedEntrySection, parentCollection: string): boolean {
  if (parentCollection === "orders" && section.collection.name === "order_items") return true;
  return parentCollection === "products" && (
    section.collection.name === "product-skus" ||
    section.collection.name === "product-translations"
  );
}

function entryTitle(data: Record<string, unknown>, fallback: string): string {
  for (const key of ["title", "name", "slug", "skuCode", "orderNumber", "orderId", "productSlug", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback.slice(0, 8);
}

function schemaType(schema: JsonSchema): string {
  const raw = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (raw) return raw;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function multilineField(schema: JsonSchema, name: string): boolean {
  const hint = typeof schema["x-mcp-hint"] === "string" ? schema["x-mcp-hint"] : "";
  return (
    hint.includes("markdown") ||
    hint.includes("html") ||
    /body|description|content|intro|notes|summary/i.test(name) ||
    (typeof schema.maxLength === "number" && schema.maxLength > 160)
  );
}

function friendlyDescription(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const raw = description.trim();
  if (!raw) return undefined;
  if (
    raw.length > 160 ||
    /`|Schema|schema|BCP|ISO|ContentState|column|MediaAsset|create_media_upload|runtime\.|@aotter/i.test(raw)
  ) {
    return undefined;
  }
  return raw;
}

function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringForInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function numberForInput(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return "";
}

function datetimeForInput(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 16);
  }
  if (typeof value !== "string" || !value) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value.slice(0, 16);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function dateTimeInputMs(value: string): number | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function defaultValueForSchema(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = schemaType(schema);
  if (type === "object") return {};
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

function readPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (typeof current === "object" && current !== null) current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function writePath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return objectValue(value);
  const clone = structuredCloneSafe(root);
  let current: unknown = clone;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      current[arrayIndex] = current[arrayIndex] ?? (isArrayIndex(nextSegment) ? [] : {});
      current = current[arrayIndex];
    } else if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      record[segment] = record[segment] ?? (isArrayIndex(nextSegment) ? [] : {});
      current = record[segment];
    }
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else if (typeof current === "object" && current !== null) {
    (current as Record<string, unknown>)[last] = value;
  }
  return clone;
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => ({ ...objectValue(item) })) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringForInput(item)) : [];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

function isArrayIndex(value: string): boolean {
  return /^\d+$/.test(value);
}
