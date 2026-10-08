import { useAdminRouter } from "../../app/router";
import { SchemaFields as SharedSchemaFields, type FieldLabels, type FieldSlot } from "@aotter/mantle-ui/kit";
export { stringFieldWidget } from "@aotter/mantle-ui/kit";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Globe, Images, ImagePlus, LockKeyhole, MoreHorizontal, Plus, RotateCcw, Save, Send } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { isFoldedFieldChild } from "../../lib/collection-nav";
import { enumOptions } from "../../lib/enum-options";
import { propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { entryApiPath, entryEditorQueryOptions, operationsQueryOptions, siteQueryOptions } from "../../lib/queries";
import { fieldContribution } from "../../lib/extensions";
import { ExtensionMount } from "../extensions/extension-mount";
import { ExtensionActions, ExtensionPanels } from "../extensions/extension-contributions";
import type {
  AdminUser,
  EntryEditorCollection,
  EntryEditorPayload,
  JsonSchema,
  MediaLibraryItem,
  MediaPurposePolicy,
  RelatedEntrySection,
  SiteInfo,
  StaffOperation,
} from "../../lib/types";
import { mantleRefOf } from "../../lib/types";
import { Button, buttonVariants } from "@aotter/mantle-ui/kit";
import { Input } from "@aotter/mantle-ui/kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@aotter/mantle-ui/kit";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aotter/mantle-ui/kit";
import { CollapsibleDescription, ErrorBox, FormActionBar, OperationErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { primaryPublicUrl, purposeForMediaField, uploadMediaAsset } from "../media/media-upload";
import { MediaBrowser } from "../media/media-library-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aotter/mantle-ui/kit";
import { collectionSummaryKey } from "./collection-view";
import { boundOperationsFor, RowOperationsMenu } from "./row-operations";
import { contentLocales, LocaleBadge, localeName } from "./locale-badge";

const MarkdownEditor = React.lazy(() => import("../editor/markdown-editor").then((module) => ({ default: module.MarkdownEditor })));
const HtmlEditor = React.lazy(() => import("../editor/html-editor").then((module) => ({ default: module.HtmlEditor })));

export function EntryEditView({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const { navigate } = useAdminRouter();
  const queryClient = useQueryClient();
  const queryOptions = React.useMemo(() => entryEditorQueryOptions(collectionName, entryId), [collectionName, entryId]);
  const query = useQuery<EntryEditorPayload>(queryOptions);
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const me = useQuery<AdminUser>({
    queryKey: ["me"],
    queryFn: () => api.get<AdminUser>("/me"),
    retry: false,
  });
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
  const boundOperations = React.useMemo(
    () => boundOperationsFor(operationsQuery.data, collectionName),
    [operationsQuery.data, collectionName],
  );
  const [data, setData] = React.useState<Record<string, unknown> | null>(null);
  const [operationalEditUnlocked, setOperationalEditUnlocked] = React.useState(false);
  React.useEffect(() => setOperationalEditUnlocked(false), [collectionName, entryId]);
  React.useEffect(() => {
    if (query.data) setData(query.data.entry.data);
  }, [query.data]);
  const syncPayload = React.useCallback(
    (payload: EntryEditorPayload) => {
      setData(payload.entry.data);
      queryClient.setQueryData(queryOptions.queryKey, payload);
    },
    [queryClient, queryOptions.queryKey],
  );

  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryEditorPayload>(entryApiPath(collectionName, entryId), {
        data: nextData,
        expectedVersion: query.data?.entry.version,
      }),
    onSuccess: syncPayload,
  });
  const publish = useMutation({
    mutationFn: () => api.post<EntryEditorPayload>(entryApiPath(collectionName, entryId, "/publish"), {}),
    onSuccess: syncPayload,
  });
  const unpublish = useMutation({
    mutationFn: () => api.post<EntryEditorPayload>(entryApiPath(collectionName, entryId, "/unpublish"), {}),
    onSuccess: syncPayload,
  });
  const createTranslation = useMutation({
    mutationFn: ({ section, locale }: { section: RelatedEntrySection; locale: string }) =>
      api.post<EntryEditorPayload>("/entries", {
        collection: section.collection.name,
        data: {
          [section.relationship.childField]: section.relationship.parentValue,
          locale,
        },
      }),
    onSuccess: (next) => {
      navigate(`/admin/c/${encodeURIComponent(next.entry.collection)}/${encodeURIComponent(next.entry.id)}`);
    },
  });

  if (query.isLoading) return <EntryEditSkeleton />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data || !data) return <ErrorBox error={new Error(t(language, "common.unknownError"))} />;

  const payload = query.data;
  const canonical = site.data?.canonicalLocale ?? null;
  const title = entryTitle(
    data,
    t(language, "collection.untitled"),
    payload.collection,
    payload.entry.id,
  );
  const collectionTitle = resolveLocalizedText(payload.collection.title, language, canonical) ?? payload.collection.name;
  const backCollection = payload.collection.translates?.parent ?? collectionName;
  const backTitle = payload.collection.translates?.parent ?? collectionTitle;
  const collectionDescription = resolveLocalizedText(payload.collection.description, language, canonical);
  const dirty = JSON.stringify(data) !== JSON.stringify(payload.entry.data);
  // Operational records (lifecycle: operational) have no content workflow:
  // no publish/unpublish controls, and they save in place regardless
  // of the stored status.
  const isOperational = payload.collection.lifecycle === "operational";
  const isReadOnly = payload.collection.schema.readOnly === true;
  const isDraft = payload.entry.status === "draft";
  const missingRequired = hasMissingRequired(data, payload.collection.schema);
  const canManageContent = me.data?.role === "owner" || me.data?.role === "editor";
  const canEdit = canEditEntry({
    role: me.data?.role,
    isReadOnly,
    isOperational,
    isDraft,
    operationalEditUnlocked,
  });
  const canSave = canEdit && dirty && (isDraft || isOperational);
  const actionPending = save.isPending || publish.isPending || unpublish.isPending;
  const mediaPurposes = site.data?.media?.purposes ?? [];
  const parentLink = parentAdminLink(payload.collection, data, payload.parentEntryId, payload.parentEntryTitle);
  const translationSections = payload.related.filter((section) => section.relationship.kind === "translation");
  const hasWorkbench = payload.related.some((section) =>
    section.relationship.kind === "field" && isFoldedFieldChild(section.collection, collectionName, section.relationship.childField)
  );
  const inlineRelated = payload.related.filter((section) =>
    section.relationship.kind === "field" && !isFoldedFieldChild(section.collection, collectionName, section.relationship.childField)
  );
  const backHref = hasWorkbench
    ? `/admin/c/${encodeURIComponent(collectionName)}/${encodeURIComponent(entryId)}`
    : `/admin/c/${encodeURIComponent(backCollection)}`;
  const currentLocale = typeof data.locale === "string" ? data.locale : "";
  const localeOptions = contentLocales(payload.collection.schema, site.data?.locales, currentLocale);
  const hiddenFields = editorHiddenFields(payload.collection);

  return (
    <div className="flex min-h-full flex-col gap-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={backHref}
              className="inline-flex items-center gap-2 hover:underline"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              {t(language, "entryEdit.back", { name: backTitle })}
            </a>
            {parentLink ? (
              <>
                <span className="text-foreground/30">/</span>
                <a href={parentLink.href} className="hover:underline">
                  {parentLink.label}
                </a>
              </>
            ) : null}
          </span>
        }
        title={title}
        actions={
          <>
            {payload.collection.localized && !payload.collection.translates ? (
              <ContentLanguageControl
                language={language}
                locale={currentLocale}
                locales={localeOptions}
                disabled={!canEdit || payload.entry.locale !== null}
                onChange={(locale) => setData({ ...data, locale })}
              />
            ) : null}
            {!isOperational && <StatusBadge status={payload.entry.status} />}
            <ExtensionActions target="record/v1" schema={payload.collection.name}
              record={{ schema: payload.collection.name, id: payload.entry.id, version: payload.entry.version }}
              onDone={() => void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey })} />
            <RowOperationsMenu
              row={payload.entry}
              collection={payload.collection}
              operations={boundOperations}
              language={language}
              canonical={canonical}
              onSuccess={() => void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey })}
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

      {translationSections.map((section) => (
        <TranslationTabs
          key={`${section.collection.name}:${section.relationship.childField}`}
          section={section}
          currentCollection={payload.collection.name}
          currentEntryId={payload.entry.id}
          sharedHref={parentLink?.href}
          language={language}
          siteLocales={site.data?.locales}
          canCreate={Boolean(me.data?.role)}
          pending={createTranslation.isPending &&
            createTranslation.variables?.section.collection.name === section.collection.name}
          onCreate={(locale) => createTranslation.mutate({ section, locale })}
        />
      ))}

      {isReadOnly ? (
        <p className="-mt-4 text-sm text-muted-foreground">
          {t(language, "entryEdit.readOnlyHint")}
        </p>
      ) : isOperational ? (
        <div className="-mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <p>{t(language, "entryEdit.operationalHint")}</p>
          {canManageContent && !operationalEditUnlocked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOperationalEditUnlocked(true)}
            >
              <LockKeyhole className="size-4" aria-hidden />
              {t(language, "entryEdit.unlockOperational")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {save.isError ? <OperationErrorBox error={save.error} /> : null}
      {publish.isError ? <OperationErrorBox error={publish.error} /> : null}
      {unpublish.isError ? <OperationErrorBox error={unpublish.error} /> : null}
      {createTranslation.isError ? <OperationErrorBox error={createTranslation.error} /> : null}

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
                uiSchema={payload.collection.uiSchema}
                value={data}
                path={[]}
                onChange={setData}
                language={language}
                canonical={canonical}
                collectionName={payload.collection.name}
                mediaPurposes={mediaPurposes}
                hiddenRootFields={hiddenFields}
              />
            </fieldset>
          </SectionCard>

          {inlineRelated.length > 0 ? (
            <RelatedSections
              sections={inlineRelated}
              parentSchema={payload.collection.schema}
              language={language}
              canonical={canonical}
              operations={operationsQuery.data}
              onOperationSuccess={() => void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey })}
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
              <MetaRow label={t(language, "collection.table.version")} value={`v${payload.entry.version}`} />
            </dl>
          </SectionCard>
          <ExtensionPanels target="record.sidebar/v1" schema={payload.collection.name} uiSchema={payload.collection.uiSchema}
            record={{ schema: payload.collection.name, id: payload.entry.id, version: payload.entry.version }} />
        </div>
      </div>

      {canEdit || (canManageContent && !isOperational && !isReadOnly) ? (
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

function EntryEditSkeleton(): React.ReactElement {
  return (
    <div className="flex min-h-full flex-col gap-6" aria-busy="true">
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-hidden>
        <SectionCard>
          <div className="mb-6 space-y-2">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="space-y-5">
            {["w-24", "w-36", "w-20", "w-32", "w-24"].map((width, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className={`h-4 ${width}`} />
                <Skeleton className={index === 2 ? "h-24 w-full" : "h-9 w-full"} />
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard className="h-fit">
          <div className="mb-5 space-y-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-48 max-w-full" />
          </div>
          <div className="space-y-4">
            {["w-20", "w-28", "w-24"].map((width, index) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <Skeleton className={`h-4 ${width}`} />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <FormActionBar status={<Skeleton className="h-4 w-28" />}>
        <Skeleton className="h-9 w-24" />
      </FormActionBar>
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

/** The shared fields (`@aotter/mantle-ui`) with Admin's strings, its media library and its rich text editors. */
export function SchemaFields({
  schema,
  uiSchema = null,
  value,
  path,
  onChange,
  language,
  canonical = null,
  collectionName,
  mediaPurposes,
  hiddenRootFields = [],
}: {
  schema: JsonSchema;
  uiSchema?: Record<string, unknown> | null;
  value: Record<string, unknown>;
  path: string[];
  onChange: (data: Record<string, unknown>) => void;
  language: AdminLanguage;
  canonical: string | null;
  collectionName: string;
  mediaPurposes: readonly MediaPurposePolicy[];
  hiddenRootFields?: readonly string[];
}): React.ReactElement {
  const labels: FieldLabels = {
    emptyOption: t(language, "entryEdit.emptyOption"),
    chooseOption: t(language, "entryEdit.chooseOption"),
    boolean: t(language, "entryEdit.boolean"),
    dateTimeSelect: t(language, "entryEdit.dateTime.select"),
    dateTimeTime: t(language, "entryEdit.dateTime.time"),
    removeItem: t(language, "entryEdit.removeItem"),
    addItem: t(language, "entryEdit.addItem"),
  };
  const site = useQuery(siteQueryOptions());
  const renderField = (field: FieldSlot): React.ReactNode | undefined => {
    const fieldSchema = field.schema as JsonSchema;
    // an Admin extension's widget (ADR-lite 1376), for a top-level field of any type: named in uiSchema, or by its `when`
    if (field.path.length === path.length + 1) {
      const config = (uiSchema?.["fields"] as Record<string, { widget?: unknown; options?: Record<string, unknown> }> | undefined)?.[field.name];
      const widget = fieldContribution(site.data, "field.input/v1", { schema: collectionName, field: field.name, property: fieldSchema, ref: config?.widget });
      if (widget) {
        return (
          <ExtensionMount extension={widget.extension} kind="fields" id={widget.id}
            place={{ field: { schema: collectionName, name: field.name, value: field.value, readOnly: false, property: fieldSchema }, ...(config?.options ? { options: config.options } : {}), onChange: field.setValue }} />
        );
      }
    }
    // only where a plain text control would go: an enum, a number, an object or a boolean keeps its own control
    if (fieldSchema.enum || enumOptions(fieldSchema) || ["boolean", "number", "integer", "object"].includes(schemaType(fieldSchema))) return undefined;
    if (isMediaAssetRef(fieldSchema)) {
      return <MediaAssetField value={field.value} path={[...field.path]} collectionName={collectionName} mediaPurposes={mediaPurposes} language={language} onChange={field.setValue} />;
    }
    const text = stringForInput(field.value);
    if (field.widget === "markdown") return <React.Suspense fallback={<Skeleton className="h-32 w-full" />}><MarkdownEditor value={text} onChange={field.setValue} /></React.Suspense>;
    if (field.widget === "html") return <React.Suspense fallback={<Skeleton className="h-32 w-full" />}><HtmlEditor value={text} onChange={field.setValue} /></React.Suspense>;
    return undefined;
  };
  return (
    <SharedSchemaFields schema={schema} uiSchema={uiSchema} value={value} path={path} onChange={onChange} language={language}
      canonical={canonical} hiddenRootFields={hiddenRootFields} labels={labels} renderField={renderField} propertyLabel={(name, fieldSchema, _language, fieldCanonical) => propertyLabel(name, fieldSchema as JsonSchema, language, fieldCanonical)} />
  );
}

export function editorHiddenFields(
  collection: Pick<EntryEditorCollection, "localized" | "translates">,
): readonly string[] {
  return [
    ...(collection.localized ? ["locale"] : []),
    ...(collection.translates ? [collection.translates.on] : []),
  ];
}

export function canEditEntry({
  role,
  isReadOnly,
  isOperational,
  isDraft,
  operationalEditUnlocked,
}: {
  role: AdminUser["role"] | undefined;
  isReadOnly: boolean;
  isOperational: boolean;
  isDraft: boolean;
  operationalEditUnlocked: boolean;
}): boolean {
  if (isReadOnly) return false;
  if (role === "owner" || role === "editor") return !isOperational || operationalEditUnlocked;
  return role === "contributor" && !isOperational && isDraft;
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

  // Resolve persisted asset ids so existing entries still show a preview.
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
        <DialogContent closeLabel={t(language, "common.close")} className="max-h-[85vh] w-full max-w-3xl overflow-y-auto">
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

/** Preview a media reference without blocking edits when the asset is missing. */
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

function RelatedSections({
  sections,
  parentSchema,
  language,
  canonical,
  operations,
  onOperationSuccess,
}: {
  sections: RelatedEntrySection[];
  parentSchema: JsonSchema | null | undefined;
  language: AdminLanguage;
  canonical: string | null;
  /** Child rows derive their own bound operations. */
  operations: readonly StaffOperation[] | undefined;
  onOperationSuccess: () => void;
}): React.ReactElement {
  return (
    <>
      {sections.map((section) => {
        const boundOperations = boundOperationsFor(operations, section.collection.name);
        return (
          <SectionCard key={`${section.collection.name}:${section.relationship.childField}`}>
            <SectionTitle
              title={resolveLocalizedText(section.collection.title, language, canonical) ?? section.collection.name}
              body={t(language, "entryEdit.relationship", {
                child: propertyLabel(section.relationship.childField, section.collection.schema?.properties?.[section.relationship.childField], language, canonical),
                parent: section.relationship.parentField === "id" ? "ID" : propertyLabel(section.relationship.parentField, parentSchema?.properties?.[section.relationship.parentField], language, canonical),
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
                          {entryTitle(
                            entry.data,
                            t(language, "collection.untitled"),
                            section.collection,
                            entry.id,
                          )}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {entry.collection}
                          <StatusBadge status={entry.status} />
                          <span>v{entry.version}</span>
                        </span>
                      </span>
                      <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </a>
                    <RowOperationsMenu
                      row={entry}
                      collection={section.collection}
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

function TranslationTabs({
  section,
  currentCollection,
  currentEntryId,
  sharedHref,
  language,
  siteLocales,
  canCreate,
  pending,
  onCreate,
}: {
  section: RelatedEntrySection;
  currentCollection: string;
  currentEntryId: string;
  sharedHref: string | undefined;
  language: AdminLanguage;
  siteLocales: readonly string[] | undefined;
  canCreate: boolean;
  pending: boolean;
  onCreate: (locale: string) => void;
}): React.ReactElement {
  const locales = contentLocales(section.collection.schema, siteLocales);
  const sharedActive = currentCollection !== section.collection.name;
  return (
    <nav aria-label={t(language, "entryEdit.languageTabs")} className="-mt-2 border-b">
      <div role="tablist" className="flex max-w-full gap-1 overflow-x-auto pb-2">
        {sharedActive ? (
          <span
            role="tab"
            aria-selected="true"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {t(language, "entryEdit.sharedFields")}
          </span>
        ) : sharedHref ? (
          <a
            role="tab"
            aria-selected="false"
            href={sharedHref}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            {t(language, "entryEdit.sharedFields")}
          </a>
        ) : null}
        {locales.map((locale) => {
          const entry = section.entries.find((candidate) => candidate.locale === locale);
          const active = entry?.id === currentEntryId;
          const label = `${localeName(locale)} · ${locale}`;
          if (entry) {
            return (
              <Tooltip key={locale}>
                <TooltipTrigger asChild>
                  <a
                    role="tab"
                    aria-selected={active}
                    aria-current={active ? "page" : undefined}
                    href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
                    className={buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" })}
                  >
                    <Globe aria-hidden />
                    <span className="max-w-40 truncate">{localeName(locale)}</span>
                    <span className="font-mono text-[0.625rem] text-muted-foreground">{locale}</span>
                  </a>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            );
          }
          const disabled = !canCreate || pending || section.relationship.parentValue === null;
          const button = (
            <Button
              type="button"
              role="tab"
              aria-selected="false"
              variant="outline"
              size="sm"
              className="border-dashed"
              disabled={disabled}
              onClick={() => onCreate(locale)}
            >
              <Plus aria-hidden />
              <span className="max-w-40 truncate">{localeName(locale)}</span>
              <span className="font-mono text-[0.625rem] text-muted-foreground">{locale}</span>
            </Button>
          );
          return section.relationship.parentValue === null ? (
            <Tooltip key={locale}>
              <TooltipTrigger asChild><span className="inline-flex">{button}</span></TooltipTrigger>
              <TooltipContent>{t(language, "entryEdit.saveSharedFirst")}</TooltipContent>
            </Tooltip>
          ) : <React.Fragment key={locale}>{button}</React.Fragment>;
        })}
      </div>
    </nav>
  );
}

function ContentLanguageControl({
  language,
  locale,
  locales,
  disabled,
  onChange,
}: {
  language: AdminLanguage;
  locale: string;
  locales: readonly string[];
  disabled: boolean;
  onChange: (locale: string) => void;
}): React.ReactElement {
  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default">
            <LocaleBadge locale={locale || null} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t(language, "entryEdit.languageLocked")}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Globe className="size-4 text-primary" aria-hidden />
      <span className="sr-only">{t(language, "entryEdit.contentLanguage")}</span>
      <Select value={locale || undefined} onValueChange={onChange}>
        <SelectTrigger size="sm" aria-label={t(language, "entryEdit.contentLanguage")}>
          <SelectValue placeholder={t(language, "entryEdit.selectLanguage")} />
        </SelectTrigger>
        <SelectContent>
          {locales.map((option) => (
            <SelectItem key={option} value={option}>
              {localeName(option)} · {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function parentAdminLink(
  collection: EntryEditorPayload["collection"],
  data: Record<string, unknown>,
  parentEntryId: string | null,
  parentEntryTitle?: string | null,
): { href: string; label: string } | null {
  if (!collection.parent || !parentEntryId) return null;
  const parentValue = data[collection.parent.childField];
  if (typeof parentValue !== "string" && typeof parentValue !== "number" && typeof parentValue !== "boolean") return null;
  return {
    href: `/admin/c/${encodeURIComponent(collection.parent.collection)}/${encodeURIComponent(parentEntryId)}`,
    label: parentEntryTitle || String(parentValue),
  };
}

export function entryTitle(
  data: Record<string, unknown>,
  fallback: string,
  collection?: Pick<EntryEditorCollection, "lifecycle" | "list" | "schema">,
  entryId?: string,
): string {
  if (collection?.lifecycle === "operational") {
    const primaryField = collection.list?.primaryField;
    const value = primaryField ? data[primaryField] : undefined;
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return entryId || fallback;
  }
  for (const key of ["title", "name", "slug", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Manifest-driven fallback: walk the schema's required properties in
  // declaration order and use the first string-typed one with a
  // non-empty value — this is how a collection with no `title`/`name`/
  // `slug` (e.g. one keyed by a domain-specific field) still gets a
  // readable label.
  if (collection?.schema) {
    const properties = collection.schema.properties ?? {};
    for (const key of collection.schema.required ?? []) {
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

function isMediaAssetRef(schema: JsonSchema): boolean {
  const ref = mantleRefOf(schema);
  return ref?.schema === "media_assets" && ref.field === "id";
}

function schemaType(schema: JsonSchema): string {
  const raw = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (raw) return raw;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function stringForInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
