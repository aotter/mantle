import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Database,
  ExternalLink,
  Globe,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api } from "../../lib/api";
import type { Collection, SiteInfo } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyField, EmptyState, ErrorBox, PageHeader, SectionCard } from "../../ui/page";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { CollectionStatisticsCard } from "./collection-statistics-card";
import { isPrimaryNavCollection } from "../../lib/collection-nav";

const CLAUDE_CUSTOMIZE_URL =
  "https://claude.ai/customize/connectors?modal=add-custom-connector";
const CLAUDE_NEW_CHAT_URL = "https://claude.ai/new";
const CHATGPT_URL = "https://chatgpt.com/";
const GROK_CONNECTORS_URL = "https://grok.com/connectors";

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
  const primaryCollections = collections.filter(isPrimaryNavCollection);
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
  const publicMcpUrl = siteInfo?.mcpEndpoints?.public ?? null;
  const staffMcpUrl = siteInfo?.mcpEndpoints?.staff ?? null;
  const mcpEndpoint = staffMcpUrl ?? publicMcpUrl;
  const isLocalMcp = mcpEndpoint
    ? ["localhost", "127.0.0.1", "::1"].includes(new URL(mcpEndpoint).hostname)
    : false;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t(language, "console.eyebrow")}
        title={siteInfo?.brand ?? t(language, "admin.consoleTitle")}
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
      ) : siteInfo && (publicMcpUrl || staffMcpUrl) ? (
        <SectionCard className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 p-5">
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
            <Badge variant="secondary">MCP</Badge>
          </div>

          <div className="grid gap-4 p-5 md:grid-cols-2">
            {publicMcpUrl ? <div className="rounded-xl border bg-muted/20 p-4">
              <div className="mb-3 flex items-start gap-3">
                <Globe className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
                <div>
                  <h3 className="font-medium">{t(language, "console.connector.public.title")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(language, "console.connector.public.body")}
                  </p>
                </div>
              </div>
              <CopyField label={t(language, "console.connector.endpointLabel")} value={publicMcpUrl} />
            </div> : null}

            {staffMcpUrl ? <div className="rounded-xl border bg-muted/20 p-4">
              <div className="mb-3 flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
                <div>
                  <h3 className="font-medium">{t(language, "console.connector.staff.title")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(language, "console.connector.staff.body")}
                  </p>
                </div>
              </div>
              <CopyField label={t(language, "console.connector.endpointLabel")} value={staffMcpUrl} />
            </div> : null}
          </div>

          {staffMcpUrl ? <div className="flex justify-end border-t border-border/70 px-5 py-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost">{t(language, "console.connector.details")}</Button>
              </DialogTrigger>
              <DialogContent
                closeLabel={t(language, "common.close")}
                className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
              >
                <DialogHeader>
                  <DialogTitle>{t(language, "console.connector.detailsTitle")}</DialogTitle>
                  <DialogDescription>{t(language, "console.connector.detailsBody")}</DialogDescription>
                </DialogHeader>
                {isLocalMcp ? (
                  <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
                    <p>{t(language, "console.connector.localWarning")}</p>
                  </div>
                ) : null}
                <Tabs defaultValue="claude">
                  <TabsList className="grid h-auto w-full grid-cols-4">
                    <TabsTrigger value="claude">Claude</TabsTrigger>
                    <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
                    <TabsTrigger value="grok">Grok</TabsTrigger>
                    <TabsTrigger value="other">{t(language, "console.connector.other")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="claude" className="space-y-4 pt-3">
                    <CopyField label={t(language, "console.connector.step1.label")} value={staffMcpUrl} />
                    <SetupSteps
                      steps={[
                        t(language, "console.connector.step1.body"),
                        t(language, "console.connector.step2.body"),
                        t(language, "console.connector.step3.body"),
                      ]}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="outline">
                        <a href={CLAUDE_CUSTOMIZE_URL} target="_blank" rel="noreferrer">
                          {t(language, "console.connector.step2.action")}
                          <ExternalLink className="size-4" aria-hidden />
                        </a>
                      </Button>
                      <Button asChild>
                        <a href={CLAUDE_NEW_CHAT_URL} target="_blank" rel="noreferrer">
                          {t(language, "console.connector.step3.action")}
                          <ExternalLink className="size-4" aria-hidden />
                        </a>
                      </Button>
                    </div>
                  </TabsContent>
                  <TabsContent value="chatgpt" className="space-y-4 pt-3">
                    <SetupSteps steps={[
                      t(language, "console.connector.chatgpt.step1"),
                      t(language, "console.connector.chatgpt.step2"),
                      t(language, "console.connector.chatgpt.step3"),
                    ]} />
                    <Button asChild variant="outline">
                      <a href={CHATGPT_URL} target="_blank" rel="noreferrer">
                        {t(language, "console.connector.chatgpt.action")}
                        <ExternalLink className="size-4" aria-hidden />
                      </a>
                    </Button>
                  </TabsContent>
                  <TabsContent value="grok" className="space-y-4 pt-3">
                    <SetupSteps steps={[
                      t(language, "console.connector.grok.step1"),
                      t(language, "console.connector.grok.step2"),
                      t(language, "console.connector.grok.step3"),
                    ]} />
                    <Button asChild variant="outline">
                      <a href={GROK_CONNECTORS_URL} target="_blank" rel="noreferrer">
                        {t(language, "console.connector.grok.action")}
                        <ExternalLink className="size-4" aria-hidden />
                      </a>
                    </Button>
                  </TabsContent>
                  <TabsContent value="other" className="pt-3">
                    <SetupSteps steps={[
                      t(language, "console.connector.other.step1"),
                      t(language, "console.connector.other.step2"),
                      t(language, "console.connector.other.step3"),
                    ]} />
                  </TabsContent>
                </Tabs>
              </DialogContent>
            </Dialog>
          </div> : null}
        </SectionCard>
      ) : null}

      <section aria-labelledby="collections-heading">
        <h2 id="collections-heading" className="mb-4 text-xl font-semibold">{t(language, "console.collections.title")}</h2>

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
          <div className="space-y-6">
            {collectionGroups.map((group) => (
              <div key={group.title}>
                {collectionGroups.length > 1 && <h3 className="mb-3 text-sm font-medium text-muted-foreground">{group.title}</h3>}
                <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                  {group.items.map((collection) => <CollectionStatisticsCard key={collection.name} collection={collection} canonical={canonical} />)}
                </div>
              </div>
            ))}
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

function SetupSteps({ steps }: { steps: string[] }): React.ReactElement {
  return (
    <ol className="space-y-3">
      {steps.map((step, index) => (
        <li key={step} className="flex gap-3 text-sm">
          <ConnectorStepNumber>{index + 1}</ConnectorStepNumber>
          <span className="pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
  );
}
