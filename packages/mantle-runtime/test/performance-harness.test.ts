import { describe, expect, it } from "vitest";
import {
  linkManifestSet,
  parseManifestSources,
  type Manifest,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import {
  compileRuntimePlan,
  type RuntimePlan,
} from "../src/domain/service/RuntimePlanCompiler.js";
import {
  benchmarkHttpRoutes,
  inspectIndexCoverage,
} from "../src/infrastructure/testing/index.js";

const schema: SchemaManifest = {
  apiVersion: "cms.mantle.aotter.net/v1",
  kind: "Schema",
  metadata: { name: "orders" },
  spec: {
    title: "Orders",
    schema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        state: { type: "string" },
        note: { type: "string" },
      },
    },
    indexes: [["tenantId", "state"]],
  },
};

function publicView(name: string, filter: ViewManifest["spec"]["filter"]): ViewManifest {
  return {
    apiVersion: "cms.mantle.aotter.net/v1",
    kind: "View",
    metadata: { name },
    spec: {
      surface: "public",
      from: "orders",
      fields: ["id", "note"],
      filter,
      limit: 20,
    },
  };
}

describe("performance harness", () => {
  it("gates public data access on the measured SQLite plan", async () => {
    const manifests: Manifest[] = [
      schema,
      publicView("orders-by-tenant-and-state", {
        and: [
          { eq: { field: "tenantId", value: "tenantId-1" } },
          { eq: { field: "state", value: "state-1" } },
        ],
      }),
      publicView("orders-by-state-only", {
        eq: { field: "state", value: "state-1" },
      }),
      publicView("orders-by-tenant-and-unindexed-note", {
        and: [
          { eq: { field: "tenantId", value: "tenantId-1" } },
          { eq: { field: "note", value: "note-1" } },
        ],
      }),
    ];

    const report = await inspectIndexCoverage(compilePlan(manifests), {
      requirePublic: true,
      rowsPerSchema: 1_000,
    });

    expect(report.summary).toMatchObject({ views: 3, required: 3, requiredFailures: 2 });
    expect(report.paths.find(({ view }) => view === "orders-by-tenant-and-state"))
      .toMatchObject({ passed: true, schemaIndexRequired: true, schemaIndexUsed: true });
    expect(report.paths.find(({ view }) => view === "orders-by-state-only"))
      .toMatchObject({ passed: false });
    expect(report.paths.find(({ view }) => view === "orders-by-tenant-and-unindexed-note"))
      .toMatchObject({
        passed: false,
        tableScan: false,
        schemaIndexUsed: false,
        dataAccessFields: ["note", "tenantId"],
      });

    const typo = await inspectIndexCoverage(compilePlan(manifests), {
      requiredViews: ["missing-view"],
      rowsPerSchema: 100,
    });
    expect(typo.summary).toMatchObject({
      required: 1,
      requiredFailures: 1,
      missingRequiredViews: ["missing-view"],
    });
  });

  it("rejects a temporary sort for only the last ORDER BY term", async () => {
    const orderedSchema: SchemaManifest = {
      ...schema,
      spec: {
        ...schema.spec,
        indexes: [["tenantId"]],
      },
    };
    const baseView = publicView("orders-by-tenant", {
      gte: { field: "tenantId", value: "tenantId-0" },
    });
    const orderedView: ViewManifest = {
      ...baseView,
      spec: {
        ...baseView.spec,
        orderBy: [
          { field: "tenantId", direction: "desc" },
          { field: "updatedAt", direction: "desc" },
        ],
      },
    };

    const report = await inspectIndexCoverage(compilePlan([orderedSchema, orderedView]), {
      requirePublic: true,
      rowsPerSchema: 1_000,
    });

    expect(report.paths[0]?.plan).toContainEqual(
      expect.stringMatching(/USE TEMP B-TREE.*ORDER BY/),
    );
    expect(report.paths[0]).toMatchObject({
      temporarySort: true,
      passed: false,
      findings: ["temporary ORDER BY B-tree"],
    });
  });

  it("reports HTTP percentiles and optional D1 metric headers", async () => {
    let request = 0;
    const fetcher: typeof globalThis.fetch = async () => {
      request += 1;
      return new Response("ok", {
        headers: {
          "x-mantle-query-count": String(request),
          "x-mantle-rows-read": String(request * 10),
        },
      });
    };

    const report = await benchmarkHttpRoutes({
      targets: [{ name: "public-list", url: "https://example.test/en/posts" }],
      rounds: 3,
      warmup: 1,
      fetch: fetcher,
    });

    expect(request).toBe(4);
    expect(report.results[0]).toMatchObject({
      name: "public-list",
      samples: 3,
      status: 200,
      queryCount: { p50: 3, p95: 4, max: 4 },
      rowsRead: { p50: 30, p95: 40, max: 40 },
    });
  });
  it("bounds concurrent arrivals, checks responses after body timing, and exposes both HTTP clocks", async () => {
    let active = 0, peak = 0, validated = 0;
    const samples: { ttfbMs: number; elapsedMs: number; responseBytes: number }[] = [];
    const result = await benchmarkHttpRoutes({
      rounds: 5, warmup: 1, concurrency: 3, onSample: (sample) => samples.push(sample),
      targets: [{ name: "stream", url: "https://example.test", init: async (iteration) => ({ headers: { "x-index": String(iteration) } }),
        validate: (_response, body) => { expect(new TextDecoder().decode(body)).toBe("ok"); validated++; } }],
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).has("x-index")).toBe(true);
        active++; peak = Math.max(peak, active);
        return new Response(new ReadableStream({ start(controller) {
          setTimeout(() => { controller.enqueue(new TextEncoder().encode("ok")); active--; controller.close(); }, 5);
        } }));
      },
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(validated).toBe(6);
    expect(samples).toHaveLength(5);
    expect(samples.every((sample) => sample.elapsedMs >= sample.ttfbMs && sample.responseBytes === 2)).toBe(true);
    expect(result.results[0]?.responseBytes).toEqual({ p50: 2, p95: 2, max: 2 });
    await expect(benchmarkHttpRoutes({ targets: [{ name: "bad", url: "https://example.test", validate: () => { throw new Error("wrong payload"); } }],
      fetch: async () => new Response("wrong") })).rejects.toThrow("wrong payload");
  });

});

function compilePlan(manifests: readonly Manifest[]): RuntimePlan {
  const parsed = parseManifestSources({
    sources: manifests.map((manifest, index) => ({
      sourceId: `test:${index}`,
      text: JSON.stringify(manifest),
    })),
  });
  if (!parsed.ok) throw new Error("expected valid performance fixture");
  const linked = linkManifestSet(parsed.value);
  if (!linked.ok) throw new Error("expected linked performance fixture");
  const compiled = compileRuntimePlan(linked.value);
  if (!compiled.ok) throw new Error("expected compiled performance fixture");
  return compiled.value;
}
