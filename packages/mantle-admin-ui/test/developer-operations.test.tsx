import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PreferencesProvider } from "../src/app/preferences";
import { DeveloperOperations } from "../src/features/logic/developer-operations";
import type { DeveloperConsoleSnapshot } from "../src/lib/types";

const declared: NonNullable<DeveloperConsoleSnapshot["operations"]> = {
  schedules: [{ id: "nightly", procedure: "cleanup", cron: "0 2 * * *", enabled: true, registration: "not-observed" }],
  ttlPolicies: [{ schema: "events", field: "expiresAt", expireAfterSeconds: 0, sweepObservation: "unavailable" }],
  observationAvailability: "available", runs: [], latestRuns: [],
};

function render(operations: DeveloperConsoleSnapshot["operations"]): string {
  return renderToStaticMarkup(createElement(PreferencesProvider, null,
    createElement(DeveloperOperations, { operations })));
}

it("separates declared schedules, unobserved registration and missing runs", () => {
  const html = render(declared);
  expect(html).toContain("nightly");
  expect(html).toContain("Not observed");
  expect(html).toContain("No run observed");
  expect(html).toContain('href="/admin/dev/logic/triggers?selected=Trigger%3Anightly"');
  expect(html).toContain('href="/admin/dev/logic/procedures?selected=Procedure%3Acleanup"');
  expect(html).toContain("events");
  expect(render({ ...declared, observationAvailability: "unavailable" })).toContain("Unavailable");
});

it("shows the last run even when it falls outside recent history", () => {
  const run = {
    scheduleId: "nightly", runId: "nightly:1700000000000", attempt: 2,
    scheduledAt: 1_700_000_000_000, startedAt: 1_700_000_000_010, finishedAt: 1_700_000_000_020,
    status: "failed" as const, durationMs: 10, errorSummary: "INTERNAL_ERROR", counts: null,
  };
  const html = render({ ...declared, runs: [run], latestRuns: [run] });
  expect(html).toContain("INTERNAL_ERROR");
  expect(html).toContain("Recent runs");
  expect(html).not.toContain("password");
  const older = render({ ...declared, runs: [], latestRuns: [run] });
  expect(older).not.toContain("No run observed");
  expect(older).toContain("Failed");
  expect(render({ ...declared, latestRuns: [{ ...run, status: "started", finishedAt: null, durationMs: null }] }))
    .toContain("Completion not observed");
});
