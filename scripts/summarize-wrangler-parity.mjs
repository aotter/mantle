import { readFile } from "node:fs/promises";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Pass one or more run-wrangler-parity JSON reports.");
const reports = await Promise.all(paths.map(async (path) => ({ path, report: JSON.parse(await readFile(path, "utf8")) })));
let seed = 812;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)];
const median = (values) => percentile(values, 0.5);
const finiteValues = (result, field) => (result.platform ?? []).filter((sample) => sample.cohort !== "first-in-isolate").flatMap((sample) => Number.isFinite(sample[field]) ? [sample[field]] : []);
function platformComparison(a, b, field) {
  const av = finiteValues(a, field), bv = finiteValues(b, field);
  return { samples: [av.length, bv.length], F2: av.length ? median(av) : null, M: bv.length ? median(bv) : null,
    delta: av.length && bv.length ? median(bv) - median(av) : null,
    delta95CI: av.length && bv.length ? interval(av, bv) : null };
}
function interval(a, b) {
  const deltas = Array.from({ length: 2000 }, () => median(b.map(() => b[Math.floor(random() * b.length)])) - median(a.map(() => a[Math.floor(random() * a.length)])));
  return [percentile(deltas, 0.025), percentile(deltas, 0.975)];
}
const summary = reports.map(({ path, report }) => {
  if (report.partial) throw new Error(`${path} is an incomplete run`);
  const comparisons = [];
  for (const baseline of report.results.filter((result) => result.name.endsWith("-F2"))) {
    const name = baseline.name.slice(0, -3), mantle = report.results.find((result) => result.name === `${name}-M`);
    if (!mantle) continue;
    const repeatSamples = (result) => result.samples.filter((_, index) => (result.platform?.[index]?.cohort ?? result.records[index]?.cohort) !== "first-in-isolate");
    const baselineMs = repeatSamples(baseline).map((sample) => sample.elapsedMs), mantleMs = repeatSamples(mantle).map((sample) => sample.elapsedMs);
    if (!baselineMs.length || !mantleMs.length) continue;
    const observedD1 = (result, field) => result.records.length && result.records.some(({ record }) => record.d1?.[field] != null) ? Math.max(...result.records.flatMap(({ record }) => record.d1?.[field] == null ? [] : [record.d1[field]])) : null;
    comparisons.push({ name, firstInIsolateSamples: { F2: baseline.samples.length - baselineMs.length, M: mantle.samples.length - mantleMs.length }, samples: [baselineMs.length, mantleMs.length],
      fullBodyP50Ms: { F2: median(baselineMs), M: median(mantleMs), delta: median(mantleMs) - median(baselineMs), delta95CI: interval(baselineMs, mantleMs) },
      platformCpuP50Ms: platformComparison(baseline, mantle, "cpuTimeMs"),
      platformWallP50Ms: platformComparison(baseline, mantle, "wallTimeMs"),
      ttfbP50Ms: { F2: median(repeatSamples(baseline).map((sample) => sample.ttfbMs)), M: median(repeatSamples(mantle).map((sample) => sample.ttfbMs)) },
      sampledActiveMsPerRequest: { F2: baseline.cpuProfile?.activeMsPerRequest ?? null, M: mantle.cpuProfile?.activeMsPerRequest ?? null },
      maxD1Statements: { F2: observedD1(baseline, "statements"), M: observedD1(mantle, "statements") },
      minD1MetadataStatements: { F2: baseline.records.length ? Math.min(...baseline.records.map(({ record }) => record.d1.metadataStatements)) : null, M: mantle.records.length ? Math.min(...mantle.records.map(({ record }) => record.d1.metadataStatements)) : null },
      maxAvailableD1RowsRead: { F2: observedD1(baseline, "rowsRead"), M: observedD1(mantle, "rowsRead") },
    });
  }
  return { path, environment: report.environment, versions: report.versions ?? null, scale: report.scale, window: [report.startedAt, report.endedAt],
    requests: report.results.reduce((n, result) => n + result.samples.length, 0),
    maxObservedHeapBytes: report.results.some((result) => result.heap) ? Math.max(...report.results.flatMap((result) => result.heap ? [result.heap.afterBatch.usedSize] : [])) : null,
    maxResponseBytes: Math.max(...report.results.map((result) => result.responseBytes.max)),
    maxSimultaneousArrivals: Math.max(...report.results.flatMap((result) => result.records.map(({ record }) => record.simultaneousArrivals))),
    expectedRejections: report.results.reduce((n, result) => n + result.samples.filter((sample) => sample.status >= 400).length, 0),
    unexpectedStatusErrors: report.results.reduce((n, result) => n + result.samples.filter((sample) => sample.status !== (result.expectedStatus ?? result.status)).length, 0),
    comparisons,
  };
});
process.stdout.write(JSON.stringify({ version: 1, note: "Comparisons use repeat-in-isolate workload samples; first-for-workload samples remain in raw reports. 95% bootstrap intervals resample requests within each run; shared-host drift and cross-request correlation are not removed. Compare alternating repeated deployment blocks for placement conclusions. CDP sampled active time is a local profiling signal, not billing CPU or per-request CPU observations.", summary }, null, 2) + "\n");
