import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useAdminLocation } from "../../app/router";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { entryEditorQueryOptions, operationsQueryOptions } from "../../lib/queries";
import { entryEditPath, foldedChildScopeValue, hasFoldedChildCollections, isFoldedFieldChild } from "../../lib/collection-nav";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { AdminUser, Collection, EntryEditorPayload, JsonSchema, SiteInfo, AdminOperation } from "../../lib/types";
import { Skeleton } from "@aotter/mantle-ui/kit";
import { Tabs, TabsList, TabsTrigger } from "@aotter/mantle-ui/kit";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { propertyLabel } from "../../lib/field-label";
import { renderDataValue } from "../../lib/render-data-value";
import { RefLink, RefTitlesProvider, useRefTarget } from "../../ui/ref-value";
import { CollectionView } from "./collection-view";
import { canEditEntry, entryTitle } from "./entry-edit-view";
import { boundOperationsFor, RecordOperations } from "./row-operations";

export function ParentEntryWorkbench({
  collectionName,
  entryId,
}: {
  collectionName: string;
  entryId: string;
}): React.ReactElement {
  const { language } = usePreferences();
  const location = useAdminLocation();
  const childParam = new URLSearchParams(location.search).get("child");
  const query = useQuery<EntryEditorPayload>(entryEditorQueryOptions(collectionName, entryId));
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

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data) return <ErrorBox error={new Error(t(language, "common.unknownError"))} />;

  const payload = query.data;
  const canonical = site.data?.canonicalLocale ?? null;
  const collectionTitle = resolveLocalizedText(payload.collection.title, language, canonical) ?? payload.collection.name;
  const title = entryTitle(
    payload.entry.data,
    t(language, "collection.untitled"),
    payload.collection,
    payload.entry.id,
  );
  const children = payload.related.filter((section) =>
    section.relationship.kind === "field" &&
    isFoldedFieldChild(section.collection, collectionName, section.relationship.childField)
  );
  const selected = children.find((section) => section.collection.name === childParam) ?? children[0];
  // the parent's value of the field the child references (its id or a unique field), never the id in its place
  const selectedScope = selected ? foldedChildScopeValue(selected.relationship) : null;
  // the list's own data columns: the primary field is already the title, and the entry payload carries no native column
  const summary = (payload.collection.list?.columns ?? []).filter((f) => f !== payload.collection.list?.primaryField && !!payload.collection.schema?.properties?.[f]);

  return (
    <div className="flex min-h-full flex-col gap-6">
      <PageHeader
        eyebrow={
          <a
            href={`/admin/c/${encodeURIComponent(collectionName)}`}
            className="inline-flex items-center gap-2 hover:underline"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {t(language, "entryEdit.back", { name: collectionTitle })}
          </a>
        }
        title={title}
        actions={
          <RecordOperations
            row={payload.entry}
            collection={payload.collection}
            operations={boundOperations}
            entryLink={{
              href: entryEditPath(collectionName, entryId),
              canEdit: canOpenForEdit(payload, me.data?.admin),
            }}
            language={language}
            canonical={canonical}
            onSuccess={() => void query.refetch()}
          />
        }
      />

      {summary.length > 0 ? (
        // what the parent itself says, as its list shows it: the person reviews the children without opening the editor first
        <SectionCard className="gap-3 p-4">
          <RefTitlesProvider value={payload.refTitles}><dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-6 gap-y-3 text-sm">
            {summary.map((field) => (
              <div key={field} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{propertyLabel(field, payload.collection.schema?.properties?.[field], language, canonical)}</dt>
                <dd className="truncate"><SummaryValue field={field} property={payload.collection.schema?.properties?.[field]} value={payload.entry.data[field]} language={language} canonical={canonical} /></dd>
              </div>
            ))}
          </dl></RefTitlesProvider>
        </SectionCard>
      ) : null}

      {children.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(language, "entryEdit.noChildEntries")}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          <Tabs value={selected?.collection.name}>
            <TabsList
              variant="line"
              aria-label={t(language, "entryWorkbench.children")}
              className="w-full justify-start overflow-x-auto rounded-none border-b"
            >
              {children.map((section) => {
                const label = resolveLocalizedText(section.collection.title, language, canonical)
                  ?? section.collection.name;
                const href = `/admin/c/${encodeURIComponent(collectionName)}/${encodeURIComponent(entryId)}?child=${encodeURIComponent(section.collection.name)}`;
                return (
                  <TabsTrigger key={section.collection.name} value={section.collection.name} asChild>
                    <a href={href} className="flex-none px-3">{label}</a>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          {selected && selectedScope === null ? (
            <p className="text-sm text-muted-foreground">{t(language, "entryEdit.noChildEntries")}</p>
          ) : selected && selectedScope !== null ? (
            <CollectionView
              collectionName={selected.collection.name}
              scope={{
                field: selected.relationship.childField,
                value: selectedScope,
              }}
              layout="panel"
              pathBase={`/admin/c/${encodeURIComponent(collectionName)}/${encodeURIComponent(entryId)}`}
              extraParams={{ child: selected.collection.name }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the parent's editor link reads Edit or View: the editor's own rule
 * (an admin, a writable Schema, a supported version). An operational record
 * still says Edit, since its editor offers the admin the unlock, as the list does.
 */
export function canOpenForEdit(payload: Pick<EntryEditorPayload, "collection" | "entry">, admin: boolean | undefined): boolean {
  const unsupportedVersion = typeof payload.entry.version !== "number" || !Number.isSafeInteger(payload.entry.version);
  return canEditEntry({
    admin,
    isReadOnly: payload.collection.schema.readOnly === true || unsupportedVersion,
    isOperational: payload.collection.lifecycle !== "publishing",
    operationalEditUnlocked: true,
  });
}

export function shouldOpenParentWorkbench(
  collections: readonly Collection[] | undefined,
  collectionName: string,
): boolean {
  return hasFoldedChildCollections(collections ?? [], collectionName);
}

/** A summary value as the list shows it; a reference the server resolved is its target's title, linked. */
function SummaryValue({ field, property, value, language, canonical }: { field: string; property: JsonSchema | undefined; value: unknown; language: AdminLanguage; canonical: string | null }): React.ReactNode {
  const target = useRefTarget(field, value);
  return target && typeof value === "string" ? <RefLink target={target} value={value} /> : renderDataValue(property, value, language, canonical);
}
