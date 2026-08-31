import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bot,
  Braces,
  Eye,
  GitBranch,
  Globe2,
  Network,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type {
  DeveloperConsoleSnapshot,
  DeveloperSurface,
  DeveloperSurfaceKind,
  SiteInfo,
} from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

const SURFACE_META: Record<DeveloperSurfaceKind, { icon: LucideIcon; tone: string }> = {
  http: { icon: Globe2, tone: "text-amber-600 dark:text-amber-300" },
  mcp: { icon: Bot, tone: "text-sky-600 dark:text-sky-300" },
  view: { icon: Eye, tone: "text-emerald-600 dark:text-emerald-300" },
  lifecycle: { icon: Activity, tone: "text-violet-600 dark:text-violet-300" },
};

export function DeveloperOverviewView(): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery<SiteInfo>({ queryKey: ["site"], queryFn: () => api.get<SiteInfo>("/site") });
  const snapshot = useQuery<DeveloperConsoleSnapshot>({
    queryKey: ["developer-console"],
    queryFn: () => api.get<DeveloperConsoleSnapshot>("/developer-console"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t(language, "developer.overview.eyebrow")}
        title={site.data?.brand ?? t(language, "developer.overview.title")}
        description={t(language, "developer.overview.description")}
        actions={snapshot.data ? (
          <Button asChild variant="outline">
            <a href="/admin/dev/logic">
              <Network className="size-4" aria-hidden />
              {t(language, "developer.overview.openLogic")}
              <ArrowRight className="size-4" aria-hidden />
            </a>
          </Button>
        ) : undefined}
      />

      {snapshot.isError ? <ErrorBox error={snapshot.error} /> : null}
      {snapshot.isLoading ? <Skeleton className="h-80 w-full rounded-xl" /> : null}

      {snapshot.data ? (
        <>
          <SectionCard className="gap-4 border-sky-500/20 bg-sky-500/[0.04] sm:flex-row sm:items-center">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300">
              <Braces className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{t(language, "developer.overview.compiled")}</h2>
                <Badge variant="outline">RuntimePlan</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{t(language, "developer.overview.compiledBody")}</p>
            </div>
            <div className="max-w-sm border-sky-500/20 text-xs text-muted-foreground sm:border-s sm:ps-4">
              <strong className="block font-medium text-foreground">{t(language, "developer.overview.notObserved")}</strong>
              {t(language, "developer.overview.notObservedBody")}
            </div>
          </SectionCard>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
            <SectionCard className="p-0">
              <div className="border-b px-5 py-4">
                <h2 className="font-semibold">{t(language, "developer.overview.interfaces")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t(language, "developer.overview.interfacesBody")}</p>
              </div>
              <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                <div className="divide-y">
                  <SurfaceGroup kind="http" surfaces={snapshot.data.surfaces} />
                  <SurfaceGroup kind="mcp" surfaces={snapshot.data.surfaces} />
                </div>
                <div className="divide-y">
                  <SurfaceGroup kind="view" surfaces={snapshot.data.surfaces} />
                  <SurfaceGroup kind="lifecycle" surfaces={snapshot.data.surfaces} />
                </div>
              </div>
            </SectionCard>

            <div className="space-y-4">
              <SectionCard>
                <div className="flex items-center gap-2">
                  <TriangleAlert className="size-4 text-amber-600 dark:text-amber-300" aria-hidden />
                  <h2 className="font-semibold">{t(language, "developer.overview.review")}</h2>
                </div>
                <p className="text-sm text-muted-foreground">{t(language, "developer.overview.reviewBody")}</p>
                <LimitationList icon={Braces} label={t(language, "developer.overview.opaqueProcedures")} items={snapshot.data.limitations.opaqueProcedures} empty={t(language, "developer.overview.noneDeclared")} />
                <LimitationList icon={Eye} label={t(language, "developer.overview.nativeViews")} items={snapshot.data.limitations.nativeViews} empty={t(language, "developer.overview.noneDeclared")} />
              </SectionCard>

              <SectionCard>
                <div className="flex items-center gap-2">
                  <GitBranch className="size-4 text-muted-foreground" aria-hidden />
                  <h2 className="font-semibold">{t(language, "developer.overview.buildDetails")}</h2>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t(language, "developer.overview.fingerprint")}</div>
                  <code className="mt-1 block break-all rounded-md border bg-muted/40 p-2 text-[11px] leading-5" title={snapshot.data.fingerprint}>{snapshot.data.fingerprint}</code>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {Object.entries(snapshot.data.summary.atoms).map(([kind, count]) => (
                    <span key={kind} className="rounded-full border px-2 py-1">{kind} <strong className="text-foreground">{count}</strong></span>
                  ))}
                </div>
              </SectionCard>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SurfaceGroup({ kind, surfaces }: { kind: DeveloperSurfaceKind; surfaces: readonly DeveloperSurface[] }): React.ReactElement {
  const { language } = usePreferences();
  const meta = SURFACE_META[kind];
  const Icon = meta.icon;
  const items = surfaces.filter((surface) => surface.kind === kind);
  const label = kind === "http" ? t(language, "developer.overview.httpRoutes")
    : kind === "mcp" ? t(language, "developer.overview.mcpTools")
      : kind === "view" ? t(language, "developer.overview.views")
        : t(language, "developer.overview.lifecycleBindings");
  return (
    <section className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className={`size-4 ${meta.tone}`} aria-hidden />
        <h3 className="text-sm font-semibold">{label}</h3>
        <Badge variant="secondary" className="ms-auto font-mono">{items.length}</Badge>
      </div>
      {items.length ? (
        <ul className="space-y-1">
          {items.map((surface) => (
            <li key={surface.id}>
              <a href={`/admin/dev/logic?selected=${encodeURIComponent(surface.ownerId)}`} className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs font-medium" title={surface.name}>{surface.name}</div>
                  <div className="truncate text-xs text-muted-foreground" title={surface.detail}>{surface.detail}</div>
                </div>
                {surface.visibility ? <Badge variant="outline" className="text-[10px]">{surface.visibility}</Badge> : null}
                <ArrowRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      ) : <p className="px-2 py-2 text-xs text-muted-foreground">{t(language, "developer.overview.noSurfaces")}</p>}
    </section>
  );
}

function LimitationList({ icon: Icon, label, items, empty }: { icon: LucideIcon; label: string; items: readonly string[]; empty: string }): React.ReactElement {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        {label}
        <span className="ms-auto font-mono text-muted-foreground">{items.length}</span>
      </div>
      <div className="mt-2 text-xs leading-5 text-muted-foreground">
        {items.length ? items.map((item) => <code key={item} className="me-1 inline-block rounded bg-background px-1.5 py-0.5 text-foreground">{item}</code>) : empty}
      </div>
    </div>
  );
}
