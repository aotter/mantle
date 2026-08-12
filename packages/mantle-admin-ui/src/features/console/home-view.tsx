import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  Database,
  ExternalLink,
  Globe,
} from "lucide-react";
import { api } from "../../lib/api";
import { fieldLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, SiteInfo } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyField, EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";

const CLAUDE_CUSTOMIZE_URL =
  "https://claude.ai/customize/connectors?modal=add-custom-connector";
const CLAUDE_NEW_CHAT_URL = "https://claude.ai/new";

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
  const collectionGroups = [
    {
      title: t(language, "nav.content"),
      items: primaryCollections.filter((collection) => collection.lifecycle !== "operational"),
    },
    {
      title: t(language, "nav.operations"),
      items: primaryCollections.filter((collection) => collection.lifecycle === "operational"),
    },
  ].filter((group) => group.items.length > 0);
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

      {site.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : site.isError ? (
        <ErrorBox error={site.error} />
      ) : siteInfo ? (
        <SectionCard className="overflow-hidden p-0">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-primary/15 p-2 text-primary">
                <Bot className="size-5" aria-hidden />
              </div>
              <div>
                <h2 className="text-lg">{t(language, "console.connector.title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t(language, "console.connector.body")}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Badge>Claude</Badge>
              <Badge variant="secondary">MCP</Badge>
            </div>
          </div>

          <div className="grid divide-y divide-border/70 md:grid-cols-3 md:divide-x md:divide-y-0">
            <div className="flex min-w-0 flex-col gap-4 p-5">
              <ConnectorStepNumber>1</ConnectorStepNumber>
              <div>
                <h3>{t(language, "console.connector.step1.title")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(language, "console.connector.step1.body")}
                </p>
              </div>
              <div className="mt-auto">
                <CopyField
                  label={t(language, "console.connector.step1.label")}
                  value={siteInfo.mcpUrl}
                />
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-4 p-5">
              <ConnectorStepNumber>2</ConnectorStepNumber>
              <div>
                <h3>{t(language, "console.connector.step2.title")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(language, "console.connector.step2.body")}
                </p>
              </div>
              <div className="mt-auto">
                <Button asChild variant="outline">
                  <a href={CLAUDE_CUSTOMIZE_URL} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" aria-hidden />
                    {t(language, "console.connector.step2.action")}
                  </a>
                </Button>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-4 p-5">
              <ConnectorStepNumber>3</ConnectorStepNumber>
              <div>
                <h3>{t(language, "console.connector.step3.title")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(language, "console.connector.step3.body")}
                </p>
              </div>
              <div className="mt-auto">
                <Button asChild>
                  <a href={CLAUDE_NEW_CHAT_URL} target="_blank" rel="noreferrer">
                    {t(language, "console.connector.step3.action")}
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <section aria-labelledby="collections-heading">
        <h2 id="collections-heading" className="mb-4 text-xl font-semibold">
          {t(language, "console.collections.title")}
        </h2>

        {collectionsQuery.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
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
          <SectionCard className="overflow-hidden p-0">
            {collectionGroups.map((group, groupIndex) => (
              <div key={group.title} className={groupIndex > 0 ? "border-t" : undefined}>
                <h3 className="border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
                  {group.title}
                </h3>
                <div className="divide-y">
                  {group.items.map((collection) => {
                    const title =
                      resolveLocalizedText(collection.title, language, canonical) ??
                      fieldLabel(collection.name);
                    const description = resolveLocalizedText(
                      collection.description,
                      language,
                      canonical,
                    );
                    const showName =
                      title.toLocaleLowerCase() !==
                      fieldLabel(collection.name).toLocaleLowerCase();
                    return (
                      <a
                        key={collection.name}
                        href={`/admin/c/${encodeURIComponent(collection.name)}`}
                        className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            <span className="truncate font-medium">{title}</span>
                            {showName ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                {collection.name}
                              </span>
                            ) : null}
                          </div>
                          {description ? (
                            <p className="truncate text-sm text-muted-foreground">
                              {description}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {collection.hasTranslations ? (
                            <Badge variant="outline" className="text-info">
                              i18n
                            </Badge>
                          ) : null}
                          {collection.mediaFields?.length ? (
                            <Badge variant="outline" className="text-success">
                              media
                            </Badge>
                          ) : null}
                          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
          </SectionCard>
        )}
      </section>
    </div>
  );
}

function ConnectorStepNumber({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex size-6 items-center justify-center rounded-full bg-foreground/10 text-xs font-semibold text-foreground">
      {children}
    </span>
  );
}
