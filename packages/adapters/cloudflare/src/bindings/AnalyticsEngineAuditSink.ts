import type { AuditSink, McpToolCallAuditEvent } from "@aotter/mantle-runtime";

/** Column order of one data point. Documented in the handbook so SQL API
 *  readers can name `blob1…blob7` / `double1…double2`; change both together. */
export const ANALYTICS_ENGINE_AUDIT_BLOBS = [
  "surface",
  "callerId",
  "clientId",
  "credential",
  "tool",
  "outcome",
  "operationId",
] as const satisfies ReadonlyArray<keyof McpToolCallAuditEvent>;
export const ANALYTICS_ENGINE_AUDIT_DOUBLES = ["at", "durationMs"] as const satisfies ReadonlyArray<
  keyof McpToolCallAuditEvent
>;

export interface AnalyticsEngineAuditSinkOptions {
  /** Dataset index, the only column Analytics Engine can filter cheaply.
   *  One dataset may hold many deployments; use the deployment's public
   *  origin so a reader can select one site or a set of them. */
  readonly index: string;
}

/**
 * `AuditSink` over a Workers Analytics Engine dataset. `writeDataPoint` is
 * synchronous and buffered by the platform, so nothing here touches the
 * response path or D1, and retention is the dataset's, not a migration.
 *
 * Ceiling: Analytics Engine keeps data for a bounded window and samples under
 * very high write rates. Longer retention or a WORM trail is an export job on
 * top of this sink, not a different sink.
 */
export function analyticsEngineAuditSink(
  dataset: AnalyticsEngineDataset,
  options: AnalyticsEngineAuditSinkOptions,
): AuditSink {
  return {
    record(event) {
      dataset.writeDataPoint({
        indexes: [options.index],
        blobs: ANALYTICS_ENGINE_AUDIT_BLOBS.map((key) => event[key] ?? ""),
        doubles: ANALYTICS_ENGINE_AUDIT_DOUBLES.map((key) => event[key]),
      });
    },
  };
}
