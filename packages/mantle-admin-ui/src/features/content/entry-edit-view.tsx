import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarIcon, ExternalLink, Globe, Images, ImagePlus, LockKeyhole, MoreHorizontal, Plus, RotateCcw, Save, Send, Trash2 } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { propertyDescription, propertyLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import { operationsQueryOptions } from "../../lib/queries";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  dateFromFieldValue,
  formatMoneyMinor,
  formatTimestampMs,
  moneyMinorHint,
  timestampHint,
} from "./field-render";
import { boundOperationsFor, RowOperationsMenu } from "./row-operations";
import { contentLocales, LocaleBadge, localeName } from "./locale-badge";

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
      window.location.href = `/admin/c/${encodeURIComponent(next.entry.collection)}/${encodeURIComponent(next.entry.id)}`;
    },
  });

  if (query.isLoading) return <EntryEditSkeleton />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data || !data) return <ErrorBox error={new Error(t(language, "common.unknownError"))} />;

  const payload = query.data;
  const canonical = site.data?.canonicalLocale ?? null;
  const title = entryTitle(data, t(language, "collection.untitled"), payload.collection.schema);
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
  const canEdit = !isReadOnly && (
    canManageContent || (me.data?.role === "contributor" && !isOperational && isDraft)
  );
  const canSave = canEdit && dirty && (isDraft || isOperational);
  const actionPending = save.isPending || publish.isPending || unpublish.isPending;
  const mediaPurposes = site.data?.media?.purposes ?? [];
  const parentLink = parentAdminLink(payload.collection, data, payload.parentEntryId);
  const translationSections = payload.related.filter((section) => section.relationship.kind === "translation");
  const inlineRelated = payload.related.filter(isPrimaryInlineSection);
  const currentLocale = typeof data.locale === "string" ? data.locale : "";
  const localeOptions = contentLocales(payload.collection.schema, site.data?.locales, currentLocale);
  const hiddenFields = editorHiddenFields(payload.collection);

  return (
    <div className="flex min-h-full flex-col gap-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={`/admin/c/${encodeURIComponent(backCollection)}`}
              className="inline-flex items-center gap-2 hover:underline"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              {t(language, "entryEdit.back", { name: backTitle })}
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

      {isReadOnly || isOperational ? (
        <p className="-mt-4 text-sm text-muted-foreground">
          {t(language, isReadOnly ? "entryEdit.readOnlyHint" : "entryEdit.operationalHint")}
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
              <MetaRow label={t(language, "collection.table.version")} value={`v${payload.entry.version}`} />
            </dl>
          </SectionCard>
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
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return (
    <div className="space-y-5">
      {Object.entries(properties)
        .filter(([name]) => path.length > 0 || !hiddenRootFields.includes(name))
        .map(([name, fieldSchema]) => (
        <SchemaField
          key={[...path, name].join(".")}
          name={name}
          schema={fieldSchema}
          widget={path.length === 0 ? fieldWidget(uiSchema, name) : null}
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

export function editorHiddenFields(
  collection: Pick<EntryEditorCollection, "localized" | "translates">,
): readonly string[] {
  return [
    ...(collection.localized ? ["locale"] : []),
    ...(collection.translates ? [collection.translates.on] : []),
  ];
}

function SchemaField({
  name,
  schema,
  widget,
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
  widget: "textarea" | null;
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
  const description = propertyDescription(schema, language, canonical);
  const setValue = (next: unknown): void => onChange(writePath(rootValue, path, next));
  // The runtime owns bound values, so the form keeps them read-only.
  const readOnly = isMantleBoundField(schema);

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {label}
        {required && !readOnly ? <span className="text-destructive">*</span> : null}
      </label>
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {readOnly ? (
        <p
          role="textbox"
          aria-readonly="true"
          className="flex min-h-9 cursor-not-allowed items-center justify-between gap-3 rounded-lg border border-transparent bg-muted px-3 py-2 text-sm text-muted-foreground"
        >
          <span>{(timestampHint(schema) ? formatTimestampMs(value) : stringForInput(value)) || t(language, "entryEdit.emptyOption")}</span>
          <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
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
            <DateTimePicker
              label={label}
              language={language}
              value={value}
              onChange={(date) => setValue(date?.getTime() ?? null)}
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
      ) : stringFieldWidget(schema, widget) === "richtext" ? (
        <RichTextEditor
          compact
          value={stringForInput(value)}
          onChange={setValue}
        />
      ) : stringFieldWidget(schema, widget) === "textarea" ? (
        <Textarea
          aria-label={label}
          className="min-h-24"
          value={stringForInput(value)}
          maxLength={schema.maxLength}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        schema.format === "date-time" ? (
          <DateTimePicker
            label={label}
            language={language}
            value={value}
            onChange={(date) => setValue(date?.toISOString() ?? "")}
          />
        ) : (
          <Input
            type="text"
            aria-label={label}
            value={stringForInput(value)}
            onChange={(event) => setValue(event.target.value)}
          />
        )
      )}
    </div>
  );
}

function DateTimePicker({
  label,
  language,
  value,
  onChange,
}: {
  label: string;
  language: AdminLanguage;
  value: unknown;
  onChange: (date: Date | undefined) => void;
}): React.ReactElement {
  const selected = dateFromFieldValue(value);
  const timeId = React.useId();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start font-normal"
          aria-label={label}
        >
          <CalendarIcon />
          {selected ? formatTimestampMs(selected.getTime()) : t(language, "entryEdit.dateTime.select")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(day) => {
            if (!day) return;
            const next = new Date(day);
            next.setHours(selected?.getHours() ?? 0, selected?.getMinutes() ?? 0, 0, 0);
            onChange(next);
          }}
        />
        <div className="flex items-center gap-3 border-t p-3">
          <label className="text-sm font-medium" htmlFor={timeId}>
            {t(language, "entryEdit.dateTime.time")}
          </label>
          <Input
            id={timeId}
            type="time"
            className="w-32"
            disabled={!selected}
            value={selected ? `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}` : ""}
            onChange={(event) => {
              if (!selected) return;
              const [hours, minutes] = event.target.value.split(":").map(Number);
              const next = new Date(selected);
              next.setHours(hours, minutes, 0, 0);
              onChange(next);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
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
): { href: string; label: string } | null {
  if (!collection.parent || !parentEntryId) return null;
  const parentValue = data[collection.parent.childField];
  if (typeof parentValue !== "string" && typeof parentValue !== "number" && typeof parentValue !== "boolean") return null;
  return {
    href: `/admin/c/${encodeURIComponent(collection.parent.collection)}/${encodeURIComponent(parentEntryId)}`,
    label: `${collection.parent.collection} / ${String(parentValue)}`,
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

export function stringFieldWidget(
  schema: JsonSchema,
  widget: "textarea" | null,
): "input" | "textarea" | "richtext" {
  const hint = typeof schema["x-mcp-hint"] === "string" ? schema["x-mcp-hint"] : "";
  if (hint === "markdown" || hint === "html" || hint === "richtext") return "richtext";
  return widget ?? "input";
}

function fieldWidget(
  uiSchema: Record<string, unknown> | null,
  name: string,
): "textarea" | null {
  const fields = uiSchema?.["fields"];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const config = (fields as Record<string, unknown>)[name];
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  return (config as Record<string, unknown>)["widget"] === "textarea" ? "textarea" : null;
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
