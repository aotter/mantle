import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  Braces,
  CheckCircle2,
  Eye,
  Globe2,
  Network,
} from "lucide-react";

import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { api } from "../../lib/api";
import type { DeveloperConsoleSnapshot, SiteInfo } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, PageHeader, SectionCard } from "../../ui/page";

export function DeveloperOverviewView(): React.ReactElement {
  const { language } = usePreferences();
  const site = useQuery<SiteInfo>({
    queryKey: ["site"],
    queryFn: () => api.get<SiteInfo>("/site"),
  });
  const snapshot = useQuery<DeveloperConsoleSnapshot>({
    queryKey: ["developer-console"],
    queryFn: () => api.get<DeveloperConsoleSnapshot>("/developer-console"),
  });
  const summary = snapshot.data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t(language, "developer.overview.eyebrow")}
        title={site.data?.brand ?? t(language, "developer.overview.title")}
        description={t(language, "developer.overview.description")}
      />

      {snapshot.isError ? <ErrorBox error={snapshot.error} /> : null}
      {snapshot.isLoading ? <Skeleton className="h-80 w-full rounded-xl" /> : null}

      {snapshot.data && summary ? (
        <>
          <SectionCard className="flex-row flex-wrap items-center gap-4 border-sky-500/20 bg-sky-500/5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300">
              <CheckCircle2 className="size-5" aria-hidden />
            </span>
            <div className="min-w-64 flex-1">
              <h2 className="font-semibold">{t(language, "developer.overview.compiled")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(language, "developer.overview.compiledBody")}
              </p>
            </div>
            <details className="group max-w-full">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                {t(language, "developer.overview.buildDetails")}
              </summary>
              <code className="mt-2 block max-w-64 truncate text-xs text-muted-foreground" title={snapshot.data.fingerprint}>
                {snapshot.data.fingerprint}
              </code>
            </details>
          </SectionCard>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t(language, "developer.overview.interfaces")}>
            <MetricCard icon={Globe2} tone="amber" value={summary.interfaces.httpRoutes} label={t(language, "developer.overview.httpRoutes")} />
            <MetricCard icon={Bot} tone="sky" value={summary.interfaces.mcpTools} label={t(language, "developer.overview.mcpTools")} />
            <MetricCard icon={Eye} tone="emerald" value={summary.interfaces.publicViews + summary.interfaces.staffViews} label={t(language, "developer.overview.readExperiences")} />
            <MetricCard icon={Braces} tone="violet" value={summary.atoms.procedures} label={t(language, "developer.overview.operations")} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard className="p-0">
              <h2 className="px-5 pt-5 text-lg font-semibold">{t(language, "developer.overview.interfaces")}</h2>
              <div className="divide-y">
                <SummaryRow label={t(language, "developer.overview.httpRoutes")} value={summary.interfaces.httpRoutes} />
                <SummaryRow label={t(language, "developer.overview.mcpTools")} value={summary.interfaces.mcpTools} />
                <SummaryRow label={t(language, "developer.overview.publicViews")} value={summary.interfaces.publicViews} />
                <SummaryRow label={t(language, "developer.overview.staffViews")} value={summary.interfaces.staffViews} />
                <SummaryRow label={t(language, "developer.overview.lifecycleBindings")} value={summary.interfaces.lifecycleBindings} />
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="text-lg font-semibold">{t(language, "developer.overview.manifest")}</h2>
              <div className="grid grid-cols-3 gap-3">
                <SummaryStat value={Object.values(summary.atoms).reduce((total, count) => total + count, 0)} label={t(language, "developer.overview.atoms")} />
                <SummaryStat value={summary.explicitRelations} label={t(language, "developer.overview.relations")} />
                <SummaryStat value={summary.opaqueHandlers} label={t(language, "developer.overview.opaque")} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-300">Trigger {summary.atoms.triggers}</Badge>
                <Badge variant="outline" className="border-violet-500/30 text-violet-700 dark:text-violet-300">Procedure {summary.atoms.procedures}</Badge>
                <Badge variant="outline" className="border-sky-500/30 text-sky-700 dark:text-sky-300">Schema {summary.atoms.schemas}</Badge>
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">View {summary.atoms.views}</Badge>
              </div>
              <Button asChild variant="outline" className="self-start">
                <a href="/admin/dev/logic">
                  <Network className="size-4" aria-hidden />
                  {t(language, "developer.overview.openLogic")}
                  <ArrowRight className="size-4" aria-hidden />
                </a>
              </Button>
            </SectionCard>
          </div>

          <SectionCard>
            <h2 className="text-lg font-semibold">{t(language, "developer.overview.review")}</h2>
            <ul className="divide-y text-sm">
              {summary.opaqueHandlers > 0 ? (
                <li className="flex gap-3 py-3 first:pt-0">
                  <span className="mt-1 size-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
                  {t(language, "developer.overview.opaqueReview", { count: String(summary.opaqueHandlers) })}
                </li>
              ) : null}
              <li className="flex gap-3 pt-3 first:pt-0">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
                {t(language, "developer.overview.healthReview")}
              </li>
            </ul>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}

const TONES = {
  amber: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  sky: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
} as const;

function MetricCard({
  icon: Icon,
  tone,
  value,
  label,
}: {
  icon: typeof Globe2;
  tone: keyof typeof TONES;
  value: number;
  label: string;
}): React.ReactElement {
  return (
    <SectionCard className="gap-3">
      <span className={`flex size-9 items-center justify-center rounded-lg ${TONES[tone]}`}>
        <Icon className="size-4" aria-hidden />
      </span>
      <div>
        <div className="text-3xl font-semibold tracking-tight">{value}</div>
        <div className="mt-1 text-sm text-muted-foreground">{label}</div>
      </div>
    </SectionCard>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <strong className="font-mono text-sm">{value}</strong>
    </div>
  );
}

function SummaryStat({ value, label }: { value: number; label: string }): React.ReactElement {
  return (
    <div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs leading-5 text-muted-foreground">{label}</div>
    </div>
  );
}
