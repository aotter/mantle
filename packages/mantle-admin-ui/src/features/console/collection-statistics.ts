export const STATISTICS_RANGES = ["1h", "24h", "7d", "20d"] as const;
export type StatisticsRange = (typeof STATISTICS_RANGES)[number];
export interface StatisticsPreferences {
  range: StatisticsRange;
  mode: "interval" | "cumulative";
}
export const STATISTICS_PREFERENCE_KEY = "cms.preference.collection-statistics";
export function parseStatisticsPreferences(raw: string | null): StatisticsPreferences {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && STATISTICS_RANGES.includes(value.range) &&
        (value.mode === "interval" || value.mode === "cumulative")) return { range: value.range, mode: value.mode };
  } catch { /* Ignore invalid/old browser preferences. */ }
  return { range: "7d", mode: "interval" };
}

export interface CollectionStatistics {
  total: number;
  from: number;
  to: number;
  bucketMs: number;
  buckets: { bucket: number; subtype: string | null; count: number }[];
}

export function statisticsSeries(data: CollectionStatistics, values: string[] | undefined, cumulative: boolean) {
  const size = Math.ceil((data.to - data.from) / data.bucketMs);
  const names: (string | null)[] = values ? [...values] : [null];
  if (values && data.buckets.some((row) => row.subtype === null)) names.push(null);
  return names.map((name) => {
    const counts = Array<number>(size).fill(0);
    for (const row of data.buckets) if (row.subtype === name && row.bucket >= 0 && row.bucket < size) counts[row.bucket] += row.count;
    const intervalTotal = counts.reduce((sum, value) => sum + value, 0);
    if (cumulative) for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1]!;
    return { name, counts, intervalTotal };
  });
}

/** Each step spans its full half-open bucket; smoothing would invent counts between buckets. */
export function stackedAreas(series: ReturnType<typeof statisticsSeries>) {
  const size = series[0]?.counts.length ?? 0;
  const baseline = Array<number>(size).fill(0);
  const max = Math.max(0, ...baseline.map((_, i) => series.reduce((sum, row) => sum + row.counts[i]!, 0)));
  const x = (i: number) => 36 + i * 336 / Math.max(1, size);
  const y = (v: number) => 112 - v * 96 / Math.max(1, max);
  const paths = series.map((row) => {
    const lower = baseline.flatMap((v, i) => [`${x(i)},${y(v)}`, `${x(i + 1)},${y(v)}`]);
    const upper = row.counts.flatMap((v, i) => {
      baseline[i] += v;
      return [`${x(i)},${y(baseline[i]!)}`, `${x(i + 1)},${y(baseline[i]!)}`];
    });
    return `M${upper.join(" L")} L${lower.reverse().join(" L")} Z`;
  });
  return { paths, max };
}

/** Quote every cell, neutralize spreadsheet formulas, and retain UTF-8 labels. */
export function statisticsCsv(data: CollectionStatistics, series: ReturnType<typeof statisticsSeries>, mode: StatisticsPreferences["mode"]): string {
  const cell = (value: string | number) => {
    const text = String(value);
    const safe = /^[\s\u0000-\u001f]*[=+@-]/u.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows: (string | number)[][] = [["interval_start", "interval_end", "current_total", "mode", ...series.map((row) => row.name ?? (series.length === 1 ? "Created" : "Other"))]];
  for (let i = 0; i < Math.ceil((data.to - data.from) / data.bucketMs); i++) {
    rows.push([new Date(data.from + i * data.bucketMs).toISOString(), new Date(Math.min(data.to, data.from + (i + 1) * data.bucketMs)).toISOString(), data.total, mode, ...series.map((row) => row.counts[i]!)]);
  }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
