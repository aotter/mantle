import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Database,
  FileText,
  Globe,
  PencilLine,
  type LucideIcon,
} from "lucide-react";
import { api } from "../../lib/api";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, SiteInfo } from "../../lib/types";
import { Button } from "../../ui/button";
import { EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";

const QUICK_ACTION_ICONS: readonly LucideIcon[] = [PencilLine, FileText, Database];

export function HomeView(): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const collectionsQuery = useQuery<Collection[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await api.get<{ collections: Collection[] }>("/collections");
      return res.collections;
    },
  });
  const collections = collectionsQuery.data ?? [];
  const primaryCollections = collections.filter((collection) => !collection.parent);
  const siteInfo = site.data;
  const canonical = siteInfo?.canonicalLocale ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t(language, "console.eyebrow")}
        title={siteInfo?.brand ?? "AotterMantle"}
        description={
          siteInfo
            ? t(language, "console.description", { title: siteInfo.title })
            : t(language, "console.descriptionFallback")
        }
        actions={
          siteInfo?.publicUrl ? (
            <Button asChild variant="outline">
              <a href={siteInfo.publicUrl} target="_blank" rel="noreferrer">
                <Globe className="size-4" aria-hidden />
                {t(language, "common.viewSite")}
              </a>
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-4">
        <SectionCard className="admin-dashboard-panel">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-xl bg-primary/15 p-2 text-primary">
              <PencilLine className="size-5" aria-hidden />
            </div>
            <div>
              <h2 className="text-lg">{t(language, "console.workspace.title")}</h2>
              <p className="text-sm text-muted-foreground">
                {t(language, "console.workspace.body")}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {primaryCollections.slice(0, 3).map((c, index) => (
              <QuickAction
                key={c.name}
                href={`/admin/c/${encodeURIComponent(c.name)}`}
                icon={QUICK_ACTION_ICONS[index % QUICK_ACTION_ICONS.length]!}
                label={resolveLocalizedText(c.title, language, canonical) ?? c.name}
              />
            ))}
          </div>
        </SectionCard>
      </div>

      <section>
        <PageHeader
          eyebrow={t(language, "console.collections.eyebrow")}
          title={t(language, "console.collections.title")}
          description={t(language, "console.collections.body")}
        />

        {collectionsQuery.isLoading && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="glass-card h-36 animate-pulse" />
            ))}
          </div>
        )}
        {collectionsQuery.isError && <ErrorBox error={collectionsQuery.error} />}
        {collectionsQuery.data && primaryCollections.length === 0 && (
          <EmptyState
            icon={Database}
            title={t(language, "console.collections.emptyTitle")}
            description={t(language, "console.collections.emptyBody")}
          />
        )}
        {primaryCollections.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {primaryCollections.map((c) => {
              const title = resolveLocalizedText(c.title, language, canonical) ?? c.name;
              const description = resolveLocalizedText(c.description, language, canonical);
              return (
              <a
                key={c.name}
                href={`/admin/c/${encodeURIComponent(c.name)}`}
                className="glass-card card-lift block p-5 no-underline text-foreground"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg" title={title}>
                      {title}
                    </h2>
                    <p className="font-mono text-xs text-muted-foreground">{c.name}</p>
                  </div>
                  <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                </div>
                {description ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {firstSentence(description)}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t(language, "console.collections.noDescription")}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {c.hasTranslations ? (
                    <span className="badge-status bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[color:var(--info)]">
                      i18n
                    </span>
                  ) : null}
                  {c.mediaFields?.length ? (
                    <span className="badge-status bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[color:var(--success)]">
                      media
                    </span>
                  ) : null}
                </div>
              </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
}): React.ReactElement {
  return (
    <a href={href} title={label} className="quick-action">
      <Icon className="size-4" aria-hidden />
      <span>{label}</span>
    </a>
  );
}

/** Home cards show only the opening sentence — the full description
 *  still renders on the collection page itself (`renderCollectionDescription`
 *  in `collection-view.tsx`). Splits on the first full stop (ASCII or
 *  ideographic) followed by a space or end of string. */
function firstSentence(description: string): string {
  const match = /^(.*?(?:。|\. ))/.exec(description);
  return (match ? match[1] : description).trim();
}
