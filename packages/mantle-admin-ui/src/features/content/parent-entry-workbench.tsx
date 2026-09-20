import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { useAdminLocation } from "../../app/router";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { entryEditorQueryOptions, operationsQueryOptions } from "../../lib/queries";
import { entryEditPath, hasFoldedChildCollections, isFoldedFieldChild } from "../../lib/collection-nav";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, EntryEditorPayload, SiteInfo, StaffOperation } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorBox, PageHeader } from "../../ui/page";
import { CollectionView } from "./collection-view";
import { entryTitle } from "./entry-edit-view";
import { boundOperationsFor, RowOperationsMenu } from "./row-operations";

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
  const operationsQuery = useQuery<StaffOperation[]>(operationsQueryOptions());
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
          <RowOperationsMenu
            row={payload.entry}
            operations={boundOperations}
            editHref={entryEditPath(collectionName, entryId)}
            language={language}
            canonical={canonical}
            onSuccess={() => void query.refetch()}
            trigger={
              <Button type="button" variant="secondary" size="icon-sm" aria-label={t(language, "rowActions.menuLabel")}>
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            }
          />
        }
      />

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
          {selected ? (
            <CollectionView
              collectionName={selected.collection.name}
              scope={{
                field: selected.relationship.childField,
                value: String(selected.relationship.parentValue ?? entryId),
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

export function shouldOpenParentWorkbench(
  collections: readonly Collection[] | undefined,
  collectionName: string,
): boolean {
  return hasFoldedChildCollections(collections ?? [], collectionName);
}
