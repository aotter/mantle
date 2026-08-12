import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Images, ImagePlus, MoreHorizontal, Plus, RotateCcw, Save, Send, Trash2 } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { propertyDescription, propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { operationsQueryOptions } from "../../lib/queries";
import type {
  AdminUser,
  EntryEditorPayload,
  JsonSchema,
  MediaLibraryItem,
  MediaPurposePolicy,
  RelatedEntrySection,
  SiteInfo,
  StaffOperation,
} from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CollapsibleDescription, ErrorBox, FormActionBar, OperationErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { RichTextEditor } from "../editor/rich-text-editor";
import { primaryPublicUrl, purposeForMediaField, uploadMediaAsset } from "../media/media-upload";
import { MediaBrowser } from "../media/media-library-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { collectionSummaryKey } from "./collection-view";
import {
  formatMoneyMinor,
  formatTimestampMs,
  hintBadgeLabel,
  moneyMinorHint,
  timestampHint,
  timestampMsForInput,
  timestampMsFromInput,
} from "./field-render";
import { boundOperationsFor, RowOperationsMenu } from "./row-operations";

export function EntryEditView({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(() => ["entry-editor", collectionName, entryId], [collectionName, entryId]);
  const query = useQuery<EntryEditorPayload>({
    queryKey,
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}`),
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });
  // Row-bound operations (#430) for this entry's own collection — same
  // query key as `collection-view.tsx`/`authenticated-layout.tsx`
  // (`operationsQueryOptions()`), so this hits react-query's shared
  // cache instead of a duplicate fetch (#442: this is what lets the
  // entry editor surface e.g. "Restock" from its page header).
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
  const boundOperations = React.useMemo(
    () => boundOperationsFor(operationsQuery.data, collectionName),
    [operationsQuery.data, collectionName],
  );
  const [data, setData] = React.useState<Record<string, unknown> | null>(null);
  React.useEffect(() => {
    if (query.data) setData(query.data.entry.data);
  }, [query.data]);
  const syncPayload = React.useCallback(
    (payload: EntryEditorPayload) => {
      setData(payload.entry.data);
      queryClient.setQueryData(queryKey, payload);
    },
    [queryClient, queryKey],
  );

  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}`, {
        data: nextData,
        expectedVersion: query.data?.entry.version,
      }),
    onSuccess: syncPayload,
  });
  const publish = useMutation({
    mutationFn: () => api.post<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}/publish`, {}),
    onSuccess: syncPayload,
  });
  const unpublish = useMutation({
    mutationFn: () => api.post<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}/unpublish`, {}),
    onSuccess: syncPayload,
  });

  if (query.isLoading) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data || !data) return <ErrorBox error={new Error("Missing entry editor payload.")} />;

  const payload = query.data;
  const canonical = site.data?.canonicalLocale ?? null;
  const title = entryTitle(data, t(language, "collection.untitled"), payload.collection.schema);
  const collectionTitle = resolveLocalizedText(payload.collection.title, language, canonical) ?? payload.collection.name;
  const collectionDescription = resolveLocalizedText(payload.collection.description, language, canonical);
  const dirty = JSON.stringify(data) !== JSON.stringify(payload.entry.data);
  // Operational records (lifecycle: operational) have no content workflow:
  // no publish/unpublish controls, and they save in place regardless
  // of the stored status.
  const isOperational = payload.collection.lifecycle === "operational";
  const isDraft = payload.entry.status === "draft";
  const missingRequired = hasMissingRequired(data, payload.collection.schema);
  const canManageContent = me.data?.role === "owner" || me.data?.role === "editor";
  const canEdit = canManageContent ||
    (me.data?.role === "contributor" && !isOperational && isDraft);
  const canSave = canEdit && dirty && (isDraft || isOperational);
  const actionPending = save.isPending || publish.isPending || unpublish.isPending;
  const mediaPurposes = site.data?.media?.purposes ?? [];
  const parentLink = parentAdminLink(payload.collection, data);
  const inlineRelated = payload.related.filter(isPrimaryInlineSection);
  const sidebarRelated = payload.related.filter((section) => !isPrimaryInlineSection(section));

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
              {t(language, "entryEdit.back", { name: collectionTitle })}
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
          name: collectionTitle,
        })}
        actions={
          <>
            {!isOperational && <StatusBadge status={payload.entry.status} />}
            <RowOperationsMenu
              row={payload.entry}
              operations={boundOperations}
              language={language}
              canonical={canonical}
              onSuccess={() => void queryClient.invalidateQueries({ queryKey })}
              trigger={
                <Button type="button" variant="secondary">
                  <MoreHorizontal className="size-4" aria-hidden />
                  {t(language, "rowActions.menuLabel")}
                </Button>
              }
            />
          </>
        }
      />

      {isOperational ? (
        <p className="-mt-4 text-sm text-muted-foreground">{t(language, "entryEdit.operationalHint")}</p>
      ) : null}

      {save.isError ? <OperationErrorBox error={save.error} /> : null}
      {publish.isError ? <OperationErrorBox error={publish.error} /> : null}
      {unpublish.isError ? <OperationErrorBox error={unpublish.error} /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <SectionCard>
            <SectionTitle
              title={t(language, "entryEdit.fields")}
              body={
                collectionDescription ? (
                  <CollapsibleDescription
                    description={collectionDescription}
                    summaryLabel={t(language, "collection.schemaDetails")}
                    collapsedIntro={t(language, collectionSummaryKey(payload.collection), {
                      name: collectionTitle,
                    })}
                  />
                ) : undefined
              }
            />
            <fieldset
              disabled={!canEdit}
              className={canEdit ? undefined : "pointer-events-none opacity-70"}
            >
              <SchemaFields
                schema={payload.collection.schema}
                value={data}
                path={[]}
                onChange={setData}
                language={language}
                canonical={canonical}
                collectionName={payload.collection.name}
                mediaPurposes={mediaPurposes}
              />
            </fieldset>
          </SectionCard>

          {inlineRelated.length > 0 ? (
            <RelatedSections
              sections={inlineRelated}
              language={language}
              canonical={canonical}
              operations={operationsQuery.data}
              onOperationSuccess={() => void queryClient.invalidateQueries({ queryKey })}
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
              {!isOperational && (
                <MetaRow label={t(language, "collection.table.status")} value={<StatusBadge status={payload.entry.status} />} />
              )}
              <MetaRow label={t(language, "collection.table.locale")} value={payload.entry.locale ?? "-"} />
              <MetaRow label={t(language, "collection.table.version")} value={`v${payload.entry.version}`} />
            </dl>
          </SectionCard>
          {sidebarRelated.length > 0 ? (
            <RelatedSections
              sections={sidebarRelated}
              language={language}
              canonical={canonical}
              operations={operationsQuery.data}
              onOperationSuccess={() => void queryClient.invalidateQueries({ queryKey })}
            />
          ) : null}
        </div>
      </div>

      {canEdit || (canManageContent && !isOperational) ? (
        <FormActionBar
          status={save.isPending
            ? t(language, "crud.saving")
            : publish.isPending
            ? t(language, "entryEdit.publishing")
            : unpublish.isPending
            ? t(language, "entryEdit.unpublishing")
            : dirty
            ? t(language, "common.unsavedChanges")
            : isDraft && !isOperational && missingRequired
            ? t(language, "entryEdit.publishMissingRequired")
            : save.isSuccess
            ? t(language, "common.saved")
            : undefined}
        >
          {canManageContent && !isOperational && (isDraft ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => publish.mutate()}
              disabled={actionPending || dirty || missingRequired}
              title={dirty
                ? t(language, "entryEdit.publishDisabledDirty")
                : missingRequired
                ? t(language, "entryEdit.publishMissingRequired")
                : t(language, "entryEdit.publishTooltip")}
            >
              <Send className="size-4" aria-hidden />
              {publish.isPending ? t(language, "entryEdit.publishing") : t(language, "entryEdit.publish")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => unpublish.mutate()}
              disabled={actionPending}
              title={t(language, "entryEdit.unpublishTooltip")}
            >
              <RotateCcw className="size-4" aria-hidden />
              {unpublish.isPending ? t(language, "entryEdit.unpublishing") : t(language, "entryEdit.unpublish")}
            </Button>
          ))}
          {canEdit ? (
            <Button
              type="button"
              onClick={() => save.mutate(data)}
              disabled={actionPending || !canSave}
              title={t(language, "entryEdit.saveTooltip")}
            >
              <Save className="size-4" aria-hidden />
              {save.isPending ? t(language, "crud.saving") : t(language, "entryEdit.save")}
            </Button>
          ) : null}
        </FormActionBar>
      ) : null}
    </div>
  );
}

function SectionTitle({
  title,
  body,
}: {
  title: string;
  body?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {body ? <div className="mt-1 text-sm leading-6 text-muted-foreground">{body}</div> : null}
    </div>
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

export function SchemaFields({
  schema,
  value,
  path,
  onChange,
  language,
  canonical = null,
  collectionName,
  mediaPurposes,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: string[];
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
  canonical: string | null;
  collectionName: string;
  mediaPurposes: readonly MediaPurposePolicy[];
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
          canonical={canonical}
          collectionName={collectionName}
          mediaPurposes={mediaPurposes}
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
  canonical = null,
  collectionName,
  mediaPurposes,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  path: string[];
  rootValue: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
  canonical: string | null;
  collectionName: string;
  mediaPurposes: readonly MediaPurposePolicy[];
}): React.ReactElement {
  const type = schemaType(schema);
  const label = propertyLabel(name, schema, language, canonical);
  // #453: `description` is the same string-or-LocalizedText shape as
  // `title` (#443) — resolve it the same way instead of only rendering
  // the plain-string case, matching the row-operation dialog
  // (`row-operations.tsx`).
  const description = propertyDescription(schema, language, canonical);
  const setValue = (next: unknown): void => onChange(writePath(rootValue, path, next));
  // Server-stamped field (#428): the runtime writes `x-mantle-bind`
  // properties itself (ctx.user / ctx.staff / now) — caller writes are
  // rejected anyway, so render read-only instead of a live control.
  const readOnly = isMantleBoundField(schema);

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 text-sm font-semibold text-foreground">
        <span>
          {label}
          {required ? <span className="ml-1 text-destructive">*</span> : null}
        </span>
        {schema["x-mcp-hint"] ? (
          <Badge variant="secondary" title={String(schema["x-mcp-hint"])}>
            {hintBadgeLabel(String(schema["x-mcp-hint"]), language)}
          </Badge>
        ) : null}
      </label>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {readOnly ? (
        <p className="min-h-8 rounded-lg border bg-muted/40 px-2.5 py-1 text-sm text-muted-foreground" title={String(schema["x-mantle-bind"])}>
          {stringForInput(value) || t(language, "entryEdit.emptyOption")}
        </p>
      ) : schema.enum ? (
        <Select
          value={stringForInput(value) || "__empty__"}
          onValueChange={(next) => setValue(next === "__empty__" ? "" : next)}
        >
          <SelectTrigger className="w-full" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__empty__">{t(language, "entryEdit.emptyOption")}</SelectItem>
            {schema.enum.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : type === "boolean" ? (
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={Boolean(value)}
            onCheckedChange={(checked) => setValue(checked === true)}
          />
          {t(language, "entryEdit.boolean")}
        </label>
      ) : type === "number" || type === "integer" ? (
        <div className="space-y-1">
          {timestampHint(schema) ? (
            <Input
              type="datetime-local"
              aria-label={label}
              value={timestampMsForInput(value)}
              onChange={(event) => setValue(timestampMsFromInput(event.target.value))}
            />
          ) : (
            <Input
              type="number"
              aria-label={label}
              value={numberForInput(value)}
              min={schema.minimum}
              max={schema.maximum}
              onChange={(event) => {
                const raw = event.target.value;
                setValue(raw === "" ? null : Number(raw));
              }}
            />
          )}
          <NumberFieldPreview schema={schema} value={value} rootValue={rootValue} />
        </div>
      ) : type === "object" ? (
        <div className="rounded-lg border bg-muted/20 p-4">
          {schema.properties ? (
            <SchemaFields
              schema={schema}
              value={rootValue}
              path={path}
              onChange={onChange}
              language={language}
              canonical={canonical}
              collectionName={collectionName}
              mediaPurposes={mediaPurposes}
            />
          ) : (
            <JsonEditor value={value} onChange={setValue} />
          )}
        </div>
      ) : isMediaAssetRef(schema) ? (
        <MediaAssetField
          value={value}
          path={path}
          collectionName={collectionName}
          mediaPurposes={mediaPurposes}
          language={language}
          onChange={setValue}
        />
      ) : type === "array" ? (
        <ArrayField
          schema={schema}
          value={Array.isArray(value) ? value : []}
          path={path}
          rootValue={rootValue}
          onChange={onChange}
          language={language}
          canonical={canonical}
          collectionName={collectionName}
          mediaPurposes={mediaPurposes}
        />
      ) : multilineField(schema, name) ? (
        <RichTextEditor
          compact
          value={stringForInput(value)}
          onChange={setValue}
        />
      ) : (
        <Input
          type={schema.format === "date-time" ? "datetime-local" : "text"}
          aria-label={label}
          value={stringForInput(value)}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
    </div>
  );
}

/** Small muted preview beside a money-minor or timestamp-ms number
 *  input, e.g. "= NT$1,299" or "= 2026/7/3 14:30". Reads the sibling
 *  `currency` property off the entry root when present; omits it
 *  otherwise (plain grouped number, no currency guess). */
function NumberFieldPreview({
  schema,
  value,
  rootValue,
}: {
  schema: JsonSchema;
  value: unknown;
  rootValue: Record<string, unknown>;
}): React.ReactElement | null {
  if (moneyMinorHint(schema)) {
    const formatted = formatMoneyMinor(value, rootValue["currency"]);
    return formatted ? <p className="text-xs text-muted-foreground">= {formatted}</p> : null;
  }
  if (timestampHint(schema)) {
    const formatted = formatTimestampMs(value);
    return formatted ? <p className="text-xs text-muted-foreground">= {formatted}</p> : null;
  }
  return null;
}

function ArrayField({
  schema,
  value,
  path,
  rootValue,
  onChange,
  language,
  canonical = null,
  collectionName,
  mediaPurposes,
}: {
  schema: JsonSchema;
  value: unknown[];
  path: string[];
  rootValue: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
  canonical: string | null;
  collectionName: string;
  mediaPurposes: readonly MediaPurposePolicy[];
}): React.ReactElement {
  const itemSchema = schema.items ?? {};
  const setArray = (next: unknown[]): void => onChange(writePath(rootValue, path, next));
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      {value.map((item, index) => (
        <div key={index} className="rounded-lg border border-border/70 bg-card/50 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-muted-foreground">#{index + 1}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={t(language, "entryEdit.removeItem")}
              aria-label={t(language, "entryEdit.removeItem")}
              onClick={() => setArray(value.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
          {schemaType(itemSchema) === "object" && itemSchema.properties ? (
            <SchemaFields
              schema={itemSchema}
              value={rootValue}
              path={[...path, String(index)]}
              onChange={onChange}
              language={language}
              canonical={canonical}
              collectionName={collectionName}
              mediaPurposes={mediaPurposes}
            />
          ) : (
            <Input
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

function MediaAssetField({
  value,
  path,
  collectionName,
  mediaPurposes,
  language,
  onChange,
}: {
  value: unknown;
  path: string[];
  collectionName: string;
  mediaPurposes: readonly MediaPurposePolicy[];
  language: AdminLanguage;
  onChange: (value: unknown) => void;
}): React.ReactElement {
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [publicUrl, setPublicUrl] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const purpose = purposeForMediaField(mediaPurposes, collectionName, path);
  const assetId = typeof value === "string" ? value : "";

  // #444: a field that already has a value only ever showed the raw
  // asset id/UUID — no confirmation of which image it actually points
  // at. `publicUrl` is only populated in-memory right after an
  // upload/pick in THIS session, so entries loaded with an existing
  // value need their own fetch via the same `GET /admin/api/media/:id`
  // the media library already uses.
  const assetQuery = useQuery({
    queryKey: ["media-asset", assetId],
    queryFn: () => api.get<MediaLibraryItem>(`/media/${encodeURIComponent(assetId)}`),
    enabled: assetId.length > 0,
    retry: false,
  });

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const asset = await uploadMediaAsset({
        file,
        purposes: mediaPurposes,
        preferredPurpose: purpose,
        language,
      });
      onChange(asset.id);
      setPublicUrl(primaryPublicUrl(asset));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <MediaAssetThumbnail assetId={assetId} asset={assetQuery.data} isError={assetQuery.isError} language={language} />
        <Input
          className="min-w-0 flex-1"
          value={stringForInput(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder="media_assets id"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => setPickerOpen(true)}
        >
          <Images className="size-4" aria-hidden />
          {t(language, "media.pick")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || mediaPurposes.length === 0}
          title={purpose ?? t(language, "entryEdit.noMediaPurpose")}
        >
          <ImagePlus className="size-4" aria-hidden />
          {uploading ? t(language, "entryEdit.uploadingMedia") : t(language, "entryEdit.uploadMedia")}
        </Button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
        }}
      />
      {purpose ? <p className="text-xs text-muted-foreground">{purpose}</p> : null}
      {publicUrl ? (
        <a className="text-xs text-primary hover:underline" href={publicUrl} target="_blank" rel="noreferrer">
          {publicUrl}
        </a>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-h-[85vh] w-full max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(language, "media.pickTitle")}</DialogTitle>
            <DialogDescription>{t(language, "media.pickDescription")}</DialogDescription>
          </DialogHeader>
          <MediaBrowser
            language={language}
            purposes={mediaPurposes}
            searchTerm=""
            emptyIcon={Images}
            onPick={(item) => {
              onChange(item.id);
              setPublicUrl(item.primaryUrl);
              setPickerOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Small thumbnail chip (#444) next to an asset-id field: confirms
 *  which image the stored id actually points at instead of leaving the
 *  operator to trust a bare UUID. `isError` covers a deleted/missing
 *  asset — the field must keep rendering normally rather than crash or
 *  block editing, so this renders a neutral placeholder icon instead
 *  of propagating the fetch error anywhere. */
function MediaAssetThumbnail({
  assetId,
  asset,
  isError,
  language,
}: {
  assetId: string;
  asset: MediaLibraryItem | undefined;
  isError: boolean;
  language: AdminLanguage;
}): React.ReactElement | null {
  if (!assetId) return null;
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40"
      title={isError ? t(language, "entryEdit.mediaMissing") : assetId}
    >
      {asset?.primaryUrl ? (
        <img src={asset.primaryUrl} alt="" className="size-full object-cover" />
      ) : (
        <Images className="size-4 text-muted-foreground" aria-hidden />
      )}
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
      <Textarea
        className="min-h-32 font-mono"
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
  canonical,
  operations,
  onOperationSuccess,
}: {
  sections: RelatedEntrySection[];
  language: AdminLanguage;
  canonical: string | null;
  /** All staff operations (#430); each row derives its own bound
   *  subset via `boundOperationsFor(operations, section.collection.name)`
   *  — the child collection, not the parent entry's collection (#442:
   *  this is what lets e.g. a product's "Product SKUs" child rows
   *  offer "Restock" without the parent editor knowing that name). */
  operations: readonly StaffOperation[] | undefined;
  onOperationSuccess: () => void;
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
      {sections.map((section) => {
        const boundOperations = boundOperationsFor(operations, section.collection.name);
        return (
          <SectionCard key={`${section.collection.name}:${section.relationship.childField}`}>
            <SectionTitle
              title={resolveLocalizedText(section.collection.title, language, canonical) ?? section.collection.name}
              body={t(language, "entryEdit.relationship", {
                child: section.relationship.childField,
                parent: section.relationship.parentField,
              })}
            />
            <div className="space-y-2">
              {section.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(language, "entryEdit.noChildEntries")}</p>
              ) : (
                section.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <a
                      href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
                      className="flex min-w-0 flex-1 items-center gap-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">
                          {entryTitle(entry.data, t(language, "collection.untitled"), section.collection.schema)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {entry.collection} / v{entry.version}
                        </span>
                      </span>
                      <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </a>
                    <RowOperationsMenu
                      row={entry}
                      operations={boundOperations}
                      language={language}
                      canonical={canonical}
                      onSuccess={onOperationSuccess}
                    />
                  </div>
                ))
              )}
            </div>
          </SectionCard>
        );
      })}
    </>
  );
}

function parentAdminLink(
  collection: EntryEditorPayload["collection"],
  data: Record<string, unknown>,
): { href: string; label: string } | null {
  if (!collection.parent) return null;
  const parentValue = data[collection.parent.childField];
  if (typeof parentValue !== "string" || !parentValue) return null;
  return {
    href: `/admin/c/${encodeURIComponent(collection.parent.collection)}?search=${encodeURIComponent(parentValue)}`,
    label: `${collection.parent.collection} / ${parentValue}`,
  };
}

function isPrimaryInlineSection(section: RelatedEntrySection): boolean {
  return section.relationship.kind === "field";
}

function entryTitle(data: Record<string, unknown>, fallback: string, schema?: JsonSchema): string {
  for (const key of ["title", "name", "slug", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Manifest-driven fallback: walk the schema's required properties in
  // declaration order and use the first string-typed one with a
  // non-empty value — this is how a collection with no `title`/`name`/
  // `slug` (e.g. one keyed by a domain-specific field) still gets a
  // readable label.
  if (schema) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      const fieldSchema = properties[key];
      if (!fieldSchema || schemaType(fieldSchema) !== "string") continue;
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}

export function hasMissingRequired(data: Record<string, unknown>, schema: JsonSchema): boolean {
  return (schema.required ?? []).some((key) => {
    const value = data[key];
    return value === undefined || value === null || value === "" ||
      (Array.isArray(value) && value.length === 0);
  });
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

function isMediaAssetRef(schema: JsonSchema): boolean {
  return schema["x-mantle-ref"] === "media_assets";
}

/** `x-mantle-bind` marks a Schema property the runtime stamps itself
 *  (`ctx.user`, `ctx.staff`, or `now` — see `MANTLE_BIND_VALUES` in
 *  the manifest grammar). Caller writes to these are rejected
 *  server-side regardless of what the admin UI sends, so the field
 *  renders read-only here rather than as a live, editable control. */
function isMantleBoundField(schema: JsonSchema): boolean {
  return typeof schema["x-mantle-bind"] === "string";
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
  const clone = structuredClone(root);
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

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isArrayIndex(value: string): boolean {
  return /^\d+$/.test(value);
}
