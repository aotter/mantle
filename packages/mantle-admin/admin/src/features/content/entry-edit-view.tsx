import { useAdminRouter } from "../../app/router";
import { SchemaFields as SharedSchemaFields, type FieldLabels, type FieldSlot } from "@aotter/mantle-ui/kit";
export { stringFieldWidget } from "@aotter/mantle-ui/kit";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Globe, Images, ImagePlus, LockKeyhole, Plus, RotateCcw, Save, Send } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { entryTitle } from "../../lib/entry-title";
import { isFoldedFieldChild } from "../../lib/collection-nav";
import { enumOptions } from "../../lib/enum-options";
import { propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { composeEntry, entryApiPath, entryEditorQueryOptions, operationsQueryOptions } from "../../lib/queries";
import { Empty, Slot } from "../../app/slots";
import type { InputProps } from "../../app/slot-props";
import type {
  AdminUser,
  EntryEditorCollection,
  EntryEditorPayload,
  EntryDocument,
  JsonSchema,
  MediaLibraryItem,
  MediaPurposePolicy,
  RelatedEntrySection,
  SiteInfo,
  AdminOperation,
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
import { boundOperationsFor, RecordOperations, RowOperationsMenu } from "./row-operations";
import { contentLocales, LocaleBadge, localeName } from "./locale-badge";
import { RefPicker } from "./ref-picker";

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
  const operationsQuery = useQuery<AdminOperation[]>(operationsQueryOptions());
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
  const [relatedError, setRelatedError] = React.useState<unknown>();
  const syncPayload = React.useCallback(
    async (document: EntryDocument) => {
      setRelatedError(undefined);
      setData(document.entry.data);
      queryClient.setQueryData(queryOptions.queryKey, { ...document, parentEntryId: null, related: [] });
      try { queryClient.setQueryData(queryOptions.queryKey, await composeEntry(document)); }
      catch (error) { setRelatedError(error); }
    },
    [queryClient, queryOptions.queryKey],
  );

  const save = useMutation({
    mutationFn: (nextData: Record<string, unknown>) =>
      api.patch<EntryDocument>(entryApiPath(collectionName, entryId), {
        data: nextData,
        expectedVersion: query.data?.entry.version,
      }),
    onSuccess: syncPayload,
  });
  const publish = useMutation({
    mutationFn: () => api.post<EntryDocument>(entryApiPath(collectionName, entryId, "/publish"), { expectedVersion: query.data?.entry.version }),
    onSuccess: syncPayload,
  });
  const unpublish = useMutation({
    mutationFn: () => api.post<EntryDocument>(entryApiPath(collectionName, entryId, "/unpublish"), { expectedVersion: query.data?.entry.version }),
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
  const isOperational = payload.collection.lifecycle !== "publishing";
  const unsupportedVersion = typeof payload.entry.version !== "number" || !Number.isSafeInteger(payload.entry.version);
  const isReadOnly = payload.collection.schema.readOnly === true || unsupportedVersion;
  const isDraft = payload.entry.status === "draft";
  const isArchived = payload.entry.status === "archived";
  const missingRequired = hasMissingRequired(data, payload.collection.schema);
  const canManageContent = me.data?.admin === true;
  const canEdit = canEditEntry({
    admin: me.data?.admin,
    isReadOnly,
    isOperational,
    isDraft,
    operationalEditUnlocked,
  });
  const canSave = canEdit && dirty;
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
      {unsupportedVersion ? <p role="status">{t(language, "entryEdit.unsupportedVersion")}</p> : null}
      {relatedError ? <ErrorBox error={relatedError} /> : null}
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
            <Slot name={`record.actions:${payload.collection.name}`} Default={Empty} props={{ collection: payload.collection.name, entry: payload.entry }} />
            <RecordOperations
              row={payload.entry}
              collection={payload.collection}
              operations={boundOperations}
              language={language}
              canonical={canonical}
              onSuccess={() => void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey })}
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
          canCreate={me.data?.admin === true}
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
      ) : !isDraft && canManageContent ? (
        <p className="-mt-4 text-sm text-muted-foreground">
          {t(language, isArchived ? "entryEdit.archivedHint" : "entryEdit.publishedHint")}
        </p>
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
                inputSlots={{ schema: payload.collection.name, readOnly: !canEdit }}
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
          <Slot name={`record.aside:${payload.collection.name}`} Default={Empty} props={{ collection: payload.collection.name, entry: payload.entry }} />
        </div>
      </div>

      {canEdit || (canManageContent && !isOperational && !isReadOnly) ? (
        <FormActionBar
          status={save.isPending
            ? t(language, "crud.saving")
            : publish.isPending
            ? t(language, "entryEdit.publishing")
            : unpublish.isPending
            ? t(language, isArchived ? "entryEdit.restoring" : "entryEdit.unpublishing")
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
              title={t(language, isArchived ? "entryEdit.restoreTooltip" : "entryEdit.unpublishTooltip")}
            >
              <RotateCcw className="size-4" aria-hidden />
              {unpublish.isPending
                ? t(language, isArchived ? "entryEdit.restoring" : "entryEdit.unpublishing")
                : t(language, isArchived ? "entryEdit.restore" : "entryEdit.unpublish")}
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
  inputSlots,
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
  /** A record form: its top-level fields go through the application's `input:<schema>.<field>` slots. */
  inputSlots?: { schema: string; readOnly: boolean };
}): React.ReactElement {
  const labels: FieldLabels = {
    emptyOption: t(language, "entryEdit.emptyOption"),
    clearOption: t(language, "entryEdit.clearOption"),
    chooseOption: t(language, "entryEdit.chooseOption"),
    clear: t(language, "entryEdit.clear"),
    boolean: t(language, "entryEdit.boolean"),
    dateTimeSelect: t(language, "entryEdit.dateTime.select"),
    dateTimeTime: t(language, "entryEdit.dateTime.time"),
    removeItem: t(language, "entryEdit.removeItem"),
    addItem: t(language, "entryEdit.addItem"),
  };
  const builtIn = (field: FieldSlot): React.ReactNode | undefined => {
    const fieldSchema = field.schema as JsonSchema;
    // only where a plain text control would go: an enum, a number, an object or a boolean keeps its own control
    if (fieldSchema.enum || enumOptions(fieldSchema) || ["boolean", "number", "integer", "object"].includes(schemaType(fieldSchema))) return undefined;
    if (isMediaAssetRef(fieldSchema)) {
      return <MediaAssetField value={field.value} path={[...field.path]} collectionName={collectionName} mediaPurposes={mediaPurposes} language={language} onChange={field.setValue} cleared={field.cleared} />;
    }
    const ref = mantleRefOf(fieldSchema);
    if (ref && ref.schema !== "media_assets" && schemaType(fieldSchema) === "string") {
      // a reference is an id or cleared, never "": a required one has no clear button unless null is one of its values
      return <RefPicker target={ref} value={field.value} onChange={field.setValue} onClear={field.required && field.cleared !== null ? undefined : () => field.setValue(field.cleared)}
        label={field.label} language={language} canonical={canonical} fallback={() => field.renderDefault()} />;
    }
    const text = stringForInput(field.value);
    // emptied rich text clears like the plain text control: null where the field clears to null, else ""
    const setText = (next: string) => field.setValue(next === "" ? (field.cleared === null ? null : "") : next);
    if (field.widget === "markdown") return <React.Suspense fallback={<Skeleton className="h-32 w-full" />}><MarkdownEditor value={text} onChange={setText} /></React.Suspense>;
    if (field.widget === "html") return <React.Suspense fallback={<Skeleton className="h-32 w-full" />}><HtmlEditor value={text} onChange={setText} /></React.Suspense>;
    return undefined;
  };
  const build = (field: FieldSlot): React.ReactNode => builtIn(field) ?? field.renderDefault({ value: field.value, setValue: field.setValue });
  // a record form's top-level fields: the application's `input:` components wrap whatever control the field has
  const renderField = (field: FieldSlot): React.ReactNode | undefined => !inputSlots || field.path.length !== path.length + 1 ? builtIn(field) : (
    <Slot name={`input:${inputSlots.schema}.${field.name}`} Default={BuiltInInput}
      props={{ value: field.value, onChange: field.setValue, readOnly: inputSlots.readOnly, property: field.schema as Record<string, unknown>, field, build }} />
  );
  return (
    // a record form saves through the entry PATCH, which clears a column only on null
    <SharedSchemaFields schema={schema} uiSchema={uiSchema} value={value} path={path} onChange={onChange} language={language} clearToNull={inputSlots !== undefined}
      canonical={canonical} hiddenRootFields={hiddenRootFields} labels={labels} renderField={renderField} propertyLabel={(name, fieldSchema, _language, fieldCanonical) => propertyLabel(name, fieldSchema as JsonSchema, language, fieldCanonical)} />
  );
}

interface BuiltInInputProps extends InputProps {
  readonly field: FieldSlot;
  readonly build: (field: FieldSlot) => React.ReactNode;
}

/** The control a field has without an `input:` slot, for the `value` and `onChange` the slot's component passes on. */
function BuiltInInput({ value, onChange, field, build }: BuiltInInputProps): React.ReactElement {
  return <>{build({ ...field, value, setValue: onChange })}</>;
}

export function editorHiddenFields(
  collection: Pick<EntryEditorCollection, "localized" | "translates">,
): readonly string[] {
  return [
    ...(collection.localized ? ["locale"] : []),
    ...(collection.translates ? [collection.translates.on] : []),
  ];
}

/** A publishing entry is edited only as a draft: a published or archived one is unpublished first, so no edit waits on a disabled Save. */
export function canEditEntry({
  admin,
  isReadOnly,
  isOperational,
  isDraft,
  operationalEditUnlocked,
}: {
  admin: boolean | undefined;
  isReadOnly: boolean;
  isOperational: boolean;
  isDraft: boolean;
  operationalEditUnlocked: boolean;
}): boolean {
  return admin === true && !isReadOnly && (isOperational ? operationalEditUnlocked : isDraft);
}

function MediaAssetField({
  value,
  path,
  collectionName,
  mediaPurposes,
  language,
  onChange,
  cleared,
}: {
  value: unknown;
  path: string[];
  collectionName: string;
  mediaPurposes: readonly MediaPurposePolicy[];
  language: AdminLanguage;
  onChange: (value: unknown) => void;
  /** What an emptied id writes: an asset id is never "". */
  cleared: null | undefined;
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
          onChange={(event) => onChange(event.target.value === "" ? cleared : event.target.value)}
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
  operations: readonly AdminOperation[] | undefined;
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
                      itemName={entryTitle(entry.data, t(language, "collection.untitled"), section.collection, entry.id)}
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

export { entryTitle } from "../../lib/entry-title";

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
