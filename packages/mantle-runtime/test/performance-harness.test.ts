import { describe, expect, it } from "vitest";
import type { Manifest, SchemaManifest, ViewManifest } from "@aotter/mantle-spec";
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

    const report = await inspectIndexCoverage(manifests, {
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

    const typo = await inspectIndexCoverage(manifests, {
      requiredViews: ["missing-view"],
      rowsPerSchema: 100,
    });
    expect(typo.summary).toMatchObject({
      required: 1,
      requiredFailures: 1,
      missingRequiredViews: ["missing-view"],
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
});
