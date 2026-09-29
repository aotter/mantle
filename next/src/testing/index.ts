/**
 * `@aotter/mantle/testing`: engine-free conformance (ADR-0034 decision 6). A driver author calls
 * `runStorageConformance({ create })` on their engine and asserts `report.ok`; no test framework is imported.
 * The cases compile their SQL with the CLI's parser, so they run in Node, not in a Worker.
 */
import type { DatabaseDriver } from "../core/driver.js";
import { Report } from "./report.js";
import * as requisition from "./cases/requisition.js";
import * as stock from "./cases/stock.js";
import * as reportView from "./cases/report-view.js";
import * as beforeHook from "./cases/before-hook.js";
import * as types from "./cases/types.js";
import * as policy from "./cases/policy.js";
import * as searchPlaces from "./cases/search-places.js";
import * as printer from "./cases/printer.js";
import * as store from "./cases/store.js";

export interface StorageConformanceFixture {
  readonly driver: DatabaseDriver;
  /** Release the database, even after a failure. */
  readonly cleanup: () => void | Promise<void>;
}

export interface StorageConformanceOptions {
  /** A fresh, empty database on the engine under test, for each case. Never supply a live database. */
  readonly create: () => Promise<StorageConformanceFixture>;
}

export interface StorageConformanceReport {
  readonly ok: boolean;
  /** Every check that ran, with its case, in order. */
  readonly checks: readonly string[];
  readonly failures: readonly { readonly check: string; readonly message: string }[];
}

const CASES: readonly [string, { run(r: Report, driver: DatabaseDriver): Promise<unknown> }][] = [
  ["requisition", requisition], ["stock", stock], ["report-view", reportView], ["before-hook", beforeHook],
  ["types", types], ["policy", policy], ["search-places", searchPlaces], ["printer", printer], ["store", store],
];

/** Runs every case on its own database. A failing case never suppresses cleanup or the cases after it. */
export async function runStorageConformance(options: StorageConformanceOptions): Promise<StorageConformanceReport> {
  const r = new Report();
  for (const [name, c] of CASES) {
    const fixture = await options.create();
    try {
      await c.run(r, fixture.driver);
    } catch (e) {
      r.section(`${name} (crashed)`);
      r.check("case ran to the end", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
    } finally {
      await fixture.cleanup();
    }
  }
  return {
    ok: r.failed.length === 0,
    checks: r.checks.map((c) => `${c.case}: ${c.name}`),
    failures: r.failed.map((c) => ({ check: `${c.case}: ${c.name}`, message: c.detail ?? "" })),
  };
}
