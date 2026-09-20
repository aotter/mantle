import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { fieldLabel } from "../../lib/field-label";
import { resolveLocalizedText } from "../../lib/localized-text";
import type { Collection } from "../../lib/types";
import { usePreferences } from "../../app/preferences";
import { t } from "../../app/i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBox, SectionCard } from "../../ui/page";
import { STATISTICS_RANGES, STATISTICS_PREFERENCE_KEY, parseStatisticsPreferences, statisticsCsv, statisticsSeries, stackedAreas, type CollectionStatistics, type StatisticsPreferences } from "./collection-statistics";

export function CollectionStatisticsCard({ collection, canonical }: {
  collection: Collection; canonical: string | null;
}): React.ReactElement {
  const { language } = usePreferences();
  const preferenceKey = `${STATISTICS_PREFERENCE_KEY}.${collection.name}`;
  const [preferences, setPreferences] = React.useState<StatisticsPreferences>(() => {
    try { return parseStatisticsPreferences(localStorage.getItem(preferenceKey)); }
    catch { return parseStatisticsPreferences(null); }
  });
  const updatePreferences = (next: StatisticsPreferences) => {
    setPreferences(next);
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)); }
    catch { /* Unavailable storage: this card still retains its in-memory choice. */ }
  };
  const query = useQuery({
    queryKey: ["collection-statistics", collection.name, preferences.range],
    queryFn: () => api.get<CollectionStatistics>(`/collections/${encodeURIComponent(collection.name)}/statistics?range=${preferences.range}`),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
  const title = resolveLocalizedText(collection.title, language, canonical) ?? fieldLabel(collection.name);
  const number = new Intl.NumberFormat(language);
  const data = query.isError ? undefined : query.data;
  const series = data ? statisticsSeries(data, collection.filter?.values, preferences.mode === "cumulative") : [];
  const { paths, max } = stackedAreas(series);
  const chartId = React.useId();
  const color = (index: number) => `color-mix(in oklch, var(--chart-${index % 5 + 1}) 75%, var(--foreground))`;
  const date = new Intl.DateTimeFormat(language, preferences.range === "1h"
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", ...((preferences.range === "7d" || preferences.range === "24h") ? { hour: "2-digit" } as const : {}) }).format;
  const seriesLabel = (name: string | null) => name === null
    ? t(language, collection.filter ? "console.stats.other" : "console.stats.new") : fieldLabel(name);
  return (
    <SectionCard className="min-w-0 gap-3 p-4">
      <h3 className="flex items-baseline justify-between gap-3 text-base font-semibold">
        <a href={`/admin/c/${encodeURIComponent(collection.name)}`} className="min-w-0 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{title}</a>
        {data && <span className="shrink-0 tabular-nums" aria-label={`${t(language, "console.stats.total")}: ${number.format(data.total)}`} title={t(language, "console.stats.total")}>{number.format(data.total)}</span>}
      </h3>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={preferences.range} onValueChange={(range) => updatePreferences({ ...preferences, range: range as StatisticsPreferences["range"] })}>
          <SelectTrigger className="text-xs" aria-label={`${title} · ${t(language, "console.stats.range")}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATISTICS_RANGES.map((range) => <SelectItem value={range} key={range}>{t(language, `console.stats.range.${range}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <div className="inline-flex rounded-md border border-input p-0.5" role="group" aria-label={`${title} · ${t(language, "console.stats.mode")}`}>
            {(["interval", "cumulative"] as const).map((mode) => <Button key={mode} variant={preferences.mode === mode ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-xs" aria-pressed={preferences.mode === mode} aria-label={t(language, `console.stats.${mode}`)} title={t(language, `console.stats.${mode}`)}
              onClick={() => updatePreferences({ ...preferences, mode })}>{t(language, `console.stats.short.${mode}`)}</Button>)}
          </div>
          {data ? <Button asChild variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground">
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(statisticsCsv(data, series, preferences.mode))}`}
              download={`${collection.name}-${preferences.range}-${preferences.mode}.csv`}
              aria-label={`${title} · ${t(language, "console.stats.download")}`} title={t(language, "console.stats.download")}>
              <Download className="size-4" aria-hidden />
            </a>
          </Button> : null}
        </div>
      </div>
      {query.isPending ? <Skeleton className="h-40" /> : query.isError ? (
        query.error instanceof ApiError && query.error.status === 501
          ? <p className="py-8 text-sm text-muted-foreground">{t(language, "console.stats.unavailable")}</p>
          : <ErrorBox error={query.error} />
      ) : data ? <>
        <svg viewBox="0 0 384 140" className="w-full text-muted-foreground" role="img" aria-labelledby={chartId}>
          <title id={chartId}>{title} · {t(language, `console.stats.${preferences.mode}`)} · {number.format(max)}</title>
          {[16, 64, 112].map((y) => <line key={y} x1="36" x2="372" y1={y} y2={y} stroke="currentColor" strokeOpacity="0.15" strokeDasharray={y === 112 ? undefined : "3 4"} />)}
          <text x="30" y="20" textAnchor="end" fill="currentColor" fontSize="10">{new Intl.NumberFormat(language, { notation: "compact" }).format(max)}</text>
          <text x="30" y="116" textAnchor="end" fill="currentColor" fontSize="10">0</text>
          {paths.map((path, i) => <path key={series[i]!.name ?? "other"} d={path} fill={color(i)} fillOpacity="0.3" stroke={color(i)} strokeWidth="1.5" strokeLinejoin="round" />)}
          <text x="36" y="134" fill="currentColor" fontSize="10">{date(data.from)}</text>
          <text x="372" y="134" textAnchor="end" fill="currentColor" fontSize="10">{date(data.to)}</text>
        </svg>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {series.map((row, i) => <span key={row.name ?? "other"} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: color(i) }} />{seriesLabel(row.name)} <span className="tabular-nums">{number.format(row.intervalTotal)}</span></span>)}
        </div>
      </> : null}
    </SectionCard>
  );
}
