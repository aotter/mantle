import { queryClient } from "../../app/query-client";
import { describe, expect, it } from "vitest";
import { parseStatisticsPreferences, statisticsSeries, statisticsCsv, stackedAreas, STATISTICS_RANGES } from "./collection-statistics";

describe("home statistics preferences and chart values", () => {
  it("invalidates all collection statistics after a successful UI mutation", async () => {
    const keys = [["collection-statistics", "orders", "7d"], ["collection-statistics", "products", "1h"]];
    keys.forEach((key) => queryClient.setQueryData(key, { total: 1 }));
    await queryClient.getMutationCache().build(queryClient, { mutationFn: async () => ({ saved: true }) }).execute(undefined);
    keys.forEach((key) => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
    queryClient.clear();
  });
  it("restores every range/mode combination and rejects invalid storage", () => {
    for (const range of STATISTICS_RANGES) for (const mode of ["interval", "cumulative"]) {
      expect(parseStatisticsPreferences(JSON.stringify({ range, mode }))).toEqual({ range, mode });
    }
    for (const raw of [null, "{", "null", "[]", '{"range":"all","mode":"cumulative"}', '{"range":"1h","mode":"unknown"}']) {
      expect(parseStatisticsPreferences(raw)).toEqual({ range: "7d", mode: "interval" });
    }
  });
  it("exports the displayed mode with exact interval bounds and safe CSV headers", () => {
    const data = { total: 9, from: 0, to: 2000, bucketMs: 1000, buckets: [
      { bucket: 0, subtype: '=SUM(1,2)', count: 2 }, { bucket: 1, subtype: '=SUM(1,2)', count: 3 },
    ] };
    const series = statisticsSeries(data, ['=SUM(1,2)', 'Quoted "name"'], true);
    const csv = statisticsCsv(data, series, "cumulative");
    expect(csv).toContain(`"'=SUM(1,2)"`);
    expect(csv).toContain('"Quoted ""name"""');
    expect(csv).toContain('"1970-01-01T00:00:01.000Z","1970-01-01T00:00:02.000Z","9","cumulative","5","0"');
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });
  it("zero-fills subtype series without mutating interval data and stacks cumulative values", () => {
    const data = { total: 10, from: 0, to: 30, bucketMs: 10, buckets: [
      { bucket: 0, subtype: "sale", count: 2 }, { bucket: 2, subtype: "sale", count: 3 },
      { bucket: 1, subtype: null, count: 1 }, { bucket: 1, subtype: "purchase", count: 4 },
    ] };
    const normal = statisticsSeries(data, ["sale", "purchase"], false);
    expect(normal.map((row) => row.counts)).toEqual([[2, 0, 3], [0, 4, 0], [0, 1, 0]]);
    const cumulative = statisticsSeries(data, ["sale", "purchase"], true);
    expect(cumulative.map((row) => row.counts)).toEqual([[2, 2, 5], [0, 4, 4], [0, 1, 1]]);
    expect(stackedAreas(normal).max).toBe(5);
    expect(stackedAreas(cumulative).max).toBe(10);
    expect(stackedAreas(cumulative).paths.every((path) => !/NaN|Infinity/.test(path))).toBe(true);
    expect(statisticsSeries({ ...data, buckets: [] }, undefined, true)[0]!.counts).toEqual([0, 0, 0]);
    const empty = stackedAreas(statisticsSeries({ ...data, buckets: [] }, undefined, false));
    expect(empty.max).toBe(0);
    expect(empty.paths.every((path) => !/NaN|Infinity/.test(path))).toBe(true);
    expect(normal[0]!.counts).toEqual([2, 0, 3]);
  });
});
