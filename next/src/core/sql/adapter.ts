/** The MantleStorageAdapter of the SQLite family: converge storage to the plan, then run on one driver (ADR-0033, ADR-0034 decision 6). */
import { DiagnosticError, makeDiagnostic, type SiteDefaults } from "../../spec/index.js";
import type { DatabaseDriver } from "../driver.js";
import type { MantleStorageAdapter } from "../service.js";
import { SqliteStoreExecutor } from "./executor.js";
import { prepareSite } from "./site.js";
import { convergeStorage } from "./storage.js";

export function sqliteStorage(driver: DatabaseDriver, options: { timeZone?: string; maxBindings?: number; site?: SiteDefaults } = {}): MantleStorageAdapter {
  return {
    async prepare(plan) {
      const report = await convergeStorage(driver, plan.schemas, { fingerprint: plan.fingerprint, timeZone: options.timeZone });
      if (report.blocked.length)
        throw new DiagnosticError(report.blocked.map((b) => makeDiagnostic({ code: b.code === "STORAGE_TABLE_NOT_OWNED" ? "STORAGE_TABLE_NOT_OWNED" : "STORAGE_CHANGE_BLOCKED", phase: "boot", severity: "error", path: `storage:${b.schema}`, message: b.message })));
      for (const u of report.undeclared) console.warn(`[mantle storage] ${u.code}: ${u.message}`);
      // Core's product tables exist only for a service that selects them
      return { executor: new SqliteStoreExecutor(driver, options.maxBindings), ...(options.site ? { site: await prepareSite(driver, options.site) } : {}) };
    },
  };
}
