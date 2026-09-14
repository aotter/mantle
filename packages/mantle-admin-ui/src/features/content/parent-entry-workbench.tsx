import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, PencilLine } from "lucide-react";
import { useAdminLocation } from "../../app/router";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { entryEditPath, hasFoldedChildCollections, isFoldedFieldChild } from "../../lib/collection-nav";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, EntryEditorPayload, SiteInfo } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "../../lib/utils";
import { ErrorBox, PageHeader } from "../../ui/page";
import { CollectionView } from "./collection-view";
import { entryTitle } from "./entry-edit-view";

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
  const query = useQuery<EntryEditorPayload>({
    queryKey: ["entry-editor", collectionName, entryId],
    queryFn: () => api.get<EntryEditorPayload>(`/entries/${encodeURIComponent(entryId)}`),
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });

  if (query.isLoading) return <div className="text-sm text-muted-foreground">{t(language, "collection.refreshing")}</div>;
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
    isFoldedFieldChild(section.collection, collectionName)
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
        description={t(language, "entryWorkbench.body", { name: collectionTitle })}
        actions={
          <Button asChild>
            <a href={entryEditPath(collectionName, entryId)}>
              <PencilLine className="size-4" aria-hidden />
              {t(language, "entryWorkbench.editEntry")}
            </a>
          </Button>
        }
      />

      {children.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(language, "entryEdit.noChildEntries")}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <nav aria-label={t(language, "entryWorkbench.children")} className="flex gap-2 overflow-x-auto lg:flex-col">
            {children.map((section) => {
              const label = resolveLocalizedText(section.collection.title, language, canonical)
                ?? section.collection.name;
              const href = `/admin/c/${encodeURIComponent(collectionName)}/${encodeURIComponent(entryId)}?child=${encodeURIComponent(section.collection.name)}`;
              const active = selected?.collection.name === section.collection.name;
              return (
                <a
                  key={section.collection.name}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "shrink-0 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "border-border bg-secondary text-secondary-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {label}
                </a>
              );
            })}
          </nav>
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
