// Small statistics helpers shared by the orchestrator and the tests. No Mantle imports.

/** @param {number[]} xs */
const sortedCopy = (xs) => [...xs].sort((a, b) => a - b);

/** Median; the mean of the two middle values when n is even. NaN for an empty input. */
export function median(xs) {
  if (!xs.length) return NaN;
  const s = sortedCopy(xs);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile: sorted[ceil(p * n) - 1]. */
export function percentile(xs, p) {
  if (!xs.length) return NaN;
  const s = sortedCopy(xs);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

export const p95 = (xs) => percentile(xs, 0.95);

/** { n, p50, p95, min, max } */
export function summarize(xs) {
  return { n: xs.length, p50: median(xs), p95: p95(xs), min: xs.length ? Math.min(...xs) : NaN, max: xs.length ? Math.max(...xs) : NaN };
}

/** The median of per-round medians, with the min..max of those medians as the range. */
export function medianOfMedians(rounds) {
  const medians = rounds.map(median);
  return { p50: median(medians), min: Math.min(...medians), max: Math.max(...medians) };
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates shuffle; returns a new array. */
export function shuffle(xs, seed) {
  const rand = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pairDiffs = (a, b) => a.map((x, i) => x - b[i]);

/**
 * Warm aggregation. `rounds` are { mantleUs[], sqlUs[], nativeUs[], cpuMantleUs, cpuNativeUs } (paired samples, µs).
 * Overhang is the median over samples of (Mantle - native) per pair; Mantle CPU is Mantle wall minus the time inside the driver.
 */
export function aggregateWarm(rounds) {
  const perRound = rounds.map((r) => ({
    n: r.mantleUs.length,
    mantle: { p50: median(r.mantleUs), p95: p95(r.mantleUs), min: Math.min(...r.mantleUs) },
    native: { p50: median(r.nativeUs), p95: p95(r.nativeUs), min: Math.min(...r.nativeUs) },
    sql: { p50: median(r.sqlUs) },
    overhang: { p50: median(pairDiffs(r.mantleUs, r.nativeUs)) },
    mantleCpu: { p50: median(pairDiffs(r.mantleUs, r.sqlUs)) },
  }));
  const across = (pick) => medianOfMedians(perRound.map((r) => [pick(r)]));
  const mantle = across((r) => r.mantle.p50);
  const native = across((r) => r.native.p50);
  return {
    rounds: perRound,
    summary: {
      n: perRound.reduce((a, r) => a + r.n, 0),
      mantleP50: mantle.p50, mantleRange: [mantle.min, mantle.max],
      nativeP50: native.p50, nativeRange: [native.min, native.max],
      mantleP95: median(perRound.map((r) => r.mantle.p95)),
      overhangP50: across((r) => r.overhang.p50).p50,
      ratio: mantle.p50 / native.p50,
      mantleCpuP50: across((r) => r.mantleCpu.p50).p50,
      sqlP50: across((r) => r.sql.p50).p50,
      cpuPerCallUs: { mantle: median(rounds.map((r) => r.cpuMantleUs)), native: median(rounds.map((r) => r.cpuNativeUs)) },
    },
  };
}

const PHASES = ["importCore", "importDialect", "importHandlers", "plan", "boot", "bootSql", "first", "firstSql", "second", "secondSql", "third"];

/**
 * Cold aggregation over fresh-process samples (the discarded warm-up sample is already removed).
 * Cold overhang = median Mantle first call - median native first call; time to first response adds imports, plan and boot.
 */
export function aggregateCold(mantle, native) {
  const col = (samples, key) => samples.map((s) => s[key]);
  const m = Object.fromEntries(PHASES.map((k) => [k, summarize(col(mantle, k))]));
  const n = Object.fromEntries(["open", "first", "firstSql", "second"].map((k) => [k, summarize(col(native, k))]));
  const sum = (keys, samples) => median(samples.map((s) => keys.reduce((a, k) => a + s[k], 0)));
  return {
    mantle: m, native: n,
    overhang: m.first.p50 - n.first.p50,
    firstMantleCpu: median(mantle.map((s) => s.first - s.firstSql)),
    timeToFirstResponse: { mantle: sum(["importCore", "importDialect", "importHandlers", "plan", "boot", "first"], mantle), native: sum(["open", "first"], native) },
    samples: { mantle: mantle.map((s) => Object.fromEntries(PHASES.map((k) => [k, s[k]]))), native: native.map((s) => ({ open: s.open, first: s.first, firstSql: s.firstSql, second: s.second })) },
  };
}
