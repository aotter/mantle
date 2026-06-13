import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, ExternalLink } from "lucide-react";
import { usePreferences, type AdminLanguage } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { Collection, EntryRow, ListEntriesResult } from "../../lib/types";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { StatusBadge } from "../../ui/status-badge";
import { collectionTitle } from "../content/collection-labels";
import { statusLabel } from "../content/status";

const TIMESTAMP_FMT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

export function ApprovalsView(): React.ReactElement {
  const { language } = usePreferences();
  const query = useQuery({
    queryKey: ["approvals", language],
    queryFn: () => loadApprovalGroups(language),
  });

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
                    {collectionTitle(group.collection, language)}
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
              <div className="divide-y divide-[var(--glass-border)] overflow-hidden rounded-lg border border-[var(--glass-border)] bg-background/25">
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
  const title = entryTitle(entry, language);
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
          {entry.collection} / v{entry.version} / {formatTimestamp(entry.updated_at)}
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
    <div className="glass-card overflow-hidden">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-[var(--glass-border)] p-4 last:border-b-0"
        >
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
          <div className="h-8 w-24 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function entryTitle(entry: EntryRow, language: AdminLanguage): string {
  if (typeof entry.title === "string" && entry.title.trim()) return entry.title;
  if (entry.title == null || entry.title === "") return t(language, "collection.untitled");
  return JSON.stringify(entry.title);
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  try {
    return TIMESTAMP_FMT.format(new Date(ms));
  } catch {
    return "-";
  }
}
