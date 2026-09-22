import { describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_ENGINE_AUDIT_BLOBS,
  ANALYTICS_ENGINE_AUDIT_DOUBLES,
  analyticsEngineAuditSink,
} from "../src/bindings/AnalyticsEngineAuditSink.js";

describe("analyticsEngineAuditSink", () => {
  it("writes one data point per event in the documented column order", () => {
    const writeDataPoint = vi.fn();
    const sink = analyticsEngineAuditSink({ writeDataPoint }, { index: "https://site.example" });
    sink.record({
      at: 1_700_000_000_000,
      surface: "public",
      callerId: "user-1",
      clientId: null,
      credential: "oauth",
      tool: "query_view_recent_posts",
      outcome: "ok",
      durationMs: 12,
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["https://site.example"],
      blobs: ["public", "user-1", "", "oauth", "query_view_recent_posts", "ok"],
      doubles: [1_700_000_000_000, 12],
    });
    // The handbook names blob1…blobN / double1…doubleN by these arrays.
    expect(ANALYTICS_ENGINE_AUDIT_BLOBS).toEqual(["surface", "callerId", "clientId", "credential", "tool", "outcome"]);
    expect(ANALYTICS_ENGINE_AUDIT_DOUBLES).toEqual(["at", "durationMs"]);
  });
});
