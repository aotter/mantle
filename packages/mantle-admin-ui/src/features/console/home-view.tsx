import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Database,
  ExternalLink,
  FileText,
  Globe,
  PencilLine,
  type LucideIcon,
} from "lucide-react";
import { api } from "../../lib/api";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection, SiteInfo } from "../../lib/types";
import { Button } from "../../ui/button";
import { CopyField, EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";

const QUICK_ACTION_ICONS: readonly LucideIcon[] = [PencilLine, FileText, Database];
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
        <div className="glass-card h-72 animate-pulse" />
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
              <span className="badge-status bg-foreground text-background">Claude</span>
              <span className="badge-status bg-accent text-accent-foreground">MCP</span>
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

function ConnectorStepNumber({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex size-6 items-center justify-center rounded-full bg-foreground/10 text-xs font-semibold text-foreground">
      {children}
    </span>
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
