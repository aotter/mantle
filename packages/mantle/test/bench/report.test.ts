// @ts-nocheck bench files are plain .mjs
import { describe, expect, it } from "vitest";
import { evaluate, failures } from "../../bench/lib/check.mjs";
import { compare, renderMarkdown } from "../../bench/lib/report.mjs";
import { aggregateCold, aggregateWarm } from "../../bench/lib/stats.mjs";

const ZERO = { compile: 0, check: 0, policy: 0, paged: 0, print: 0, zod: 0, storeIr: 0, deparse: 0 };
const OK = Object.fromEntries(Object.keys(ZERO).map((k) => [k, "ok"]));
const item = { name: "view:a", minRows: 1, zeroWarm: ["compile", "check", "policy", "paged", "print", "zod", "storeIr"], zeroFirst: [] };
const result = (over = {}) => ({ item: "view:a", rows: 3, parity: { record: [[3]], native: [[3]], mantle: [[3]] }, counters: { first: { ...ZERO, compile: 1 }, warm: ZERO, status: OK }, ...over });
const levels = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.level}:${c.rule}`);

describe("check rules", () => {
  it("passes a clean result", () => {
    expect(levels(evaluate({ results: [result()], items: [item] }))).toEqual([]);
  });
  it("fails on a non-zero warm counter, too few rows, a parity mismatch and a thrown item", () => {
    expect(levels(evaluate({ results: [result({ counters: { first: ZERO, warm: { ...ZERO, compile: 1, print: 2 }, status: OK } })], items: [item] }))).toEqual(["fail:zeroWarm:compile", "fail:zeroWarm:print"]);
    expect(levels(evaluate({ results: [result({ rows: 0 })], items: [item] }))).toEqual(["fail:minRows"]);
    expect(levels(evaluate({ results: [result({ parity: { record: [[3]], native: [[2]], mantle: [[3]] } })], items: [item] }))).toEqual(["fail:parity"]);
    expect(levels(evaluate({ results: [{ item: "view:a", error: "Error: boom\n at x" }], items: [item] }))).toEqual(["fail:ran"]);
  });
  it("a missing counter target is fatal only for an item that names it", () => {
    const missing = { ...OK, compile: "missing", deparse: "ok" };
    const r = result({ counters: { first: ZERO, warm: ZERO, status: missing } });
    expect(levels(evaluate({ results: [r], items: [item] }))).toEqual(["fail:counter:compile"]);
    expect(levels(evaluate({ results: [r], items: [{ ...item, zeroWarm: [] }] }))).toEqual(["warn:counter:compile"]);
  });
  it("timing warns, and fails only with strictTiming", () => {
    const slow = result({ warm: { summary: { overhangP50: 9000, nativeP50: 100 } }, cold: { overhang: 500 } });
    const thresholds = { warm: { overheadUsMax: 2000, overheadRatioMax: 5 }, cold: { firstCallOverheadMsMax: 300 } };
    const lax = evaluate({ results: [slow], items: [item], thresholds });
    expect(levels(lax)).toEqual(["warn:timing:warm", "warn:timing:cold"]);
    expect(failures(lax)).toEqual([]);
    expect(failures(evaluate({ results: [slow], items: [item], thresholds, strictTiming: true }))).toHaveLength(2);
  });
});

describe("aggregation and rendering", () => {
  const warm = aggregateWarm([{ mantleUs: [10, 20, 30], sqlUs: [4, 4, 4], nativeUs: [5, 5, 5], cpuMantleUs: 7, cpuNativeUs: 3 }, { mantleUs: [20, 20, 20], sqlUs: [4, 4, 4], nativeUs: [10, 10, 10], cpuMantleUs: 9, cpuNativeUs: 4 }]);
  it("warm overhang is the per-pair median and ratio is p50 over p50", () => {
    expect(warm.rounds[0].overhang.p50).toBe(15);
    expect(warm.summary.overhangP50).toBe(12.5);
    expect(warm.summary.mantleP50).toBe(20);
    expect(warm.summary.nativeP50).toBe(7.5);
    expect(warm.summary.mantleCpuP50).toBe(16);
    expect(warm.summary.cpuPerCallUs).toEqual({ mantle: 8, native: 3.5 });
  });
  it("cold overhang is median Mantle first minus median native first", () => {
    const phase = (v) => ({ importCore: 100, importDialect: 30, importHandlers: 1, plan: 1, boot: 10, bootSql: 1, first: v, firstSql: 1, second: 2, secondSql: 1, third: 1 });
    const cold = aggregateCold([phase(20), phase(30), phase(40)], [{ open: 1, first: 2, firstSql: 1, second: 1 }, { open: 1, first: 4, firstSql: 1, second: 1 }]);
    expect(cold.overhang).toBe(30 - 3);
    expect(cold.timeToFirstResponse.native).toBe(1 + 3);
  });
  it("renders markdown and compares two documents", () => {
    const doc = (label, mantleP50) => ({
      schema: "mantle-bench/1", env: { node: "v22", platform: "linux x64", cpu: "cpu", cpus: 4, date: "2026-01-01" }, config: { mode: "all", app: "training", rounds: 1, samples: 1, warmup: 1, budgetMs: 1, coldSamples: 1, counters: true },
      variants: [{ label, version: "0", sha: "abc" }], checks: [],
      results: [{ variant: label, dialect: "sqlite", item: "view:a", kind: "view", statements: 1, warm: { summary: { ...warm.summary, mantleP50 } }, counters: { first: { ...ZERO, compile: 1 }, warm: ZERO } }],
    });
    expect(renderMarkdown(doc("base", 100))).toContain("| view:a | view |");
    const text = compare(doc("base", 100), doc("head", 50));
    expect(text).toContain("100 -> 50 (-50%)");
    expect(text).toContain("1/0/0/0/0/0/0 -> 1/0/0/0/0/0/0");
  });
});
