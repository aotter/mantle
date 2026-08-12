import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, ExternalLink } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, EntryRow, ListEntriesResult, SiteInfo } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { statusLabel } from "../content/status";
import { formatTimestampMs } from "../content/field-render";
import { renderTitleText } from "../../lib/entry-title";

export function ApprovalsView(): React.ReactElement {
  const { language } = usePreferences();
  const query = useQuery({
    queryKey: ["approvals", language],
    queryFn: () => loadApprovalGroups(language),
  });
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const canonical = site.data?.canonicalLocale ?? null;

  const groups = query.data ?? [];
  const reviewCount = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <div>
      <PageHeader
        eyebrow="AotterMantle"
        title={t(language, "approvals.title")}
        description={t(language, "approvals.body")}
        actions={<StatusBadge status="review" />}
      />

      {query.isLoading ? <ApprovalsSkeleton /> : null}
      {query.isError ? <ErrorBox error={query.error} /> : null}
      {!query.isLoading && !query.isError && reviewCount === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t(language, "approvals.emptyTitle")}
          description={t(language, "approvals.emptyBody")}
        />
      ) : null}
      {reviewCount > 0 ? (
        <div className="space-y-4">
          {groups.map((group) => (
            <SectionCard key={group.collection.name}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {resolveLocalizedText(group.collection.title, language, canonical) ?? group.collection.name}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(language, "approvals.groupBody", {
                      count: String(group.entries.length),
                      status: statusLabel(language, "review"),
                    })}
                  </p>
                </div>
                <Button asChild variant="secondary" size="sm">
                  <a href={`/admin/c/${encodeURIComponent(group.collection.name)}?status=review`}>
                    {t(language, "approvals.openCollection")}
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </Button>
              </div>
              <div className="divide-y overflow-hidden rounded-lg border">
                {group.entries.map((entry) => (
                  <ApprovalRow
                    key={entry.id}
                    entry={entry}
                    language={language}
                  />
                ))}
              </div>
            </SectionCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}

async function loadApprovalGroups(language: AdminLanguage): Promise<ApprovalGroup[]> {
  const { collections } = await api.get<{ collections: Collection[] }>("/collections");
  const editorialCollections = collections.filter((collection) => collection.lifecycle === "editorial");
  const groups = await Promise.all(
    editorialCollections.map(async (collection) => {
      const qs = new URLSearchParams({
        collection: collection.name,
        status: "review",
        limit: "99",
        locale: language,
      });
      const result = await api.get<ListEntriesResult>(`/entries?${qs.toString()}`);
      return { collection, entries: result.items };
    }),
  );
  return groups.filter((group) => group.entries.length > 0);
}

type ApprovalGroup = {
  collection: Collection;
  entries: EntryRow[];
};

function ApprovalRow({
  entry,
  language,
}: {
  entry: EntryRow;
  language: AdminLanguage;
}): React.ReactElement {
  const title = renderTitleText(entry.title, language);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <a
          href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}
          className="block truncate text-sm font-semibold text-foreground hover:underline"
          title={title}
        >
          {title}
        </a>
        <p className="mt-1 text-xs text-muted-foreground">
          {entry.collection} / v{entry.version} / {formatTimestampMs(entry.updated_at) ?? "-"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={entry.status} />
        <Button asChild size="sm">
          <a href={`/admin/c/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}`}>
            {t(language, "approvals.reviewEntry")}
          </a>
        </Button>
      </div>
    </div>
  );
}

function ApprovalsSkeleton(): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b p-4 last:border-b-0"
        >
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-8 w-24" />
        </div>
      ))}
    </div>
  );
}
