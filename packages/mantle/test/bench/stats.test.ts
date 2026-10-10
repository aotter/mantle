// @ts-nocheck bench files are plain .mjs
import { describe, expect, it } from "vitest";
import { median, medianOfMedians, mulberry32, p95, percentile, shuffle, summarize } from "../../bench/lib/stats.mjs";
import { decode, encode, parse, stringify } from "../../bench/lib/codec.mjs";

describe("stats", () => {
  it("median is the mean of the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([])).toBeNaN();
  });
  it("p95 is nearest-rank", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(hundred)).toBe(95);
    expect(p95([5])).toBe(5);
    expect(percentile(hundred, 0.5)).toBe(50);
  });
  it("median of round medians, with its range", () => {
    expect(medianOfMedians([[1, 2, 3], [10, 20, 30], [4, 5, 6]])).toEqual({ p50: 5, min: 2, max: 20 });
  });
  it("summarize reports n, p50, p95, min and max", () => {
    expect(summarize([3, 1, 2])).toEqual({ n: 3, p50: 2, p95: 3, min: 1, max: 3 });
  });
  it("mulberry32 is a fixed sequence", () => {
    const rand = mulberry32(1);
    expect([rand(), rand(), rand()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });
  it("shuffle is a deterministic permutation", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(xs, 7)).toEqual(shuffle(xs, 7));
    expect(shuffle(xs, 7)).not.toEqual(shuffle(xs, 8));
    expect([...shuffle(xs, 7)].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]).toBe(0); // the input is not mutated
  });
});

describe("codec", () => {
  it("round-trips bigint, bytes, dates, undefined and nesting through JSON", () => {
    const value = [1n << 70n, new Uint8Array([1, 2, 255]), new Date("2026-01-02T03:04:05.000Z"), undefined, null, "x", { a: [2n] }];
    expect(parse(stringify(value))).toEqual(value);
    expect(decode(encode(5))).toBe(5);
  });
});
