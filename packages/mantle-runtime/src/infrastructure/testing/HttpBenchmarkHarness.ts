export interface HttpBenchmarkTarget {
  readonly name: string;
  readonly url: string | ((iteration: number) => string);
  readonly init?: RequestInit;
  readonly expectedStatus?: number;
}

export interface HttpBenchmarkOptions {
  readonly targets: readonly HttpBenchmarkTarget[];
  readonly rounds?: number;
  readonly warmup?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HttpBenchmarkResult {
  readonly name: string;
  readonly samples: number;
  readonly status: number;
  readonly timingMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly queryCount?: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly rowsRead?: { readonly p50: number; readonly p95: number; readonly max: number };
}

export interface HttpBenchmarkReport {
  readonly version: 1;
  readonly rounds: number;
  readonly warmup: number;
  readonly results: readonly HttpBenchmarkResult[];
}

/** Sample live Worker routes. Optional metric headers come from a test wrapper. */
export async function benchmarkHttpRoutes(
  options: HttpBenchmarkOptions,
): Promise<HttpBenchmarkReport> {
  const rounds = clampCount(options.rounds, 20, 1, 500);
  const warmup = clampCount(options.warmup, 2, 0, 50);
  const fetcher = options.fetch ?? globalThis.fetch;
  const results: HttpBenchmarkResult[] = [];

  for (const target of options.targets) {
    for (let index = 0; index < warmup; index += 1) {
      await sample(fetcher, target, index);
    }
    const timings: number[] = [];
    const queryCounts: number[] = [];
    const rowsRead: number[] = [];
    let status = 0;
    for (let index = 0; index < rounds; index += 1) {
      const current = await sample(fetcher, target, index + warmup);
      status = current.status;
      timings.push(current.elapsedMs);
      if (current.queryCount !== undefined) queryCounts.push(current.queryCount);
      if (current.rowsRead !== undefined) rowsRead.push(current.rowsRead);
    }
    assertMetricCoverage(target.name, "x-mantle-query-count", queryCounts.length, rounds);
    assertMetricCoverage(target.name, "x-mantle-rows-read", rowsRead.length, rounds);
    results.push({
      name: target.name,
      samples: rounds,
      status,
      timingMs: distribution(timings),
      ...(queryCounts.length > 0 ? { queryCount: distribution(queryCounts) } : {}),
      ...(rowsRead.length > 0 ? { rowsRead: distribution(rowsRead) } : {}),
    });
  }

  return { version: 1, rounds, warmup, results };
}

async function sample(
  fetcher: typeof globalThis.fetch,
  target: HttpBenchmarkTarget,
  iteration: number,
): Promise<{
  readonly status: number;
  readonly elapsedMs: number;
  readonly queryCount?: number;
  readonly rowsRead?: number;
}> {
  const start = performance.now();
  const response = await fetcher(
    typeof target.url === "function" ? target.url(iteration) : target.url,
    target.init,
  );
  await response.arrayBuffer();
  const elapsedMs = performance.now() - start;
  const expected = target.expectedStatus ?? 200;
  if (response.status !== expected) {
    throw new Error(`${target.name} returned ${response.status}; expected ${expected}`);
  }
  const queryCount = numberHeader(response, "x-mantle-query-count");
  const rowsRead = numberHeader(response, "x-mantle-rows-read");
  return {
    status: response.status,
    elapsedMs,
    ...(queryCount === undefined ? {} : { queryCount }),
    ...(rowsRead === undefined ? {} : { rowsRead }),
  };
}

function numberHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function assertMetricCoverage(
  target: string,
  header: string,
  samples: number,
  rounds: number,
): void {
  if (samples !== 0 && samples !== rounds) {
    throw new Error(`${target} returned ${header} for ${samples}/${rounds} measured requests`);
  }
}

function distribution(values: readonly number[]): { p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? sorted[0]!;
}

function clampCount(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
