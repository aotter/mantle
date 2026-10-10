/** The MantleStorageAdapter for PostgreSQL: converge storage to the plan, then run on `PgConnect` (ADR-0033, ADR-0035). */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import { restricted, type RestrictSql } from "../core/dialect.js";
import type { MantleStorageAdapter } from "../core/service.js";
import { postgresDialect } from "./dialect.js";
import { bootRead, type PgConnect } from "./driver.js";
import { PgStoreExecutor } from "./executor.js";
import { checkMessages, convergeStorage } from "./storage.js";

export interface PostgresStorageOptions {
  /** Opens one connected client: `async () => { const c = new pg.Client(env.HYPERDRIVE.connectionString); await c.connect(); return c; }`. */
  readonly connect: PgConnect;
  /** The site time zone `date_trunc` and `extract` compute in (IANA name). Default UTC. */
  readonly timeZone?: string;
  /**
   * Each statement's limit, in milliseconds. Default 10 000; 0 is no limit (ADR-0037 decision 5). A write batch sets it on its
   * transaction; a read runs under the role's `statement_timeout`, which boot requires to be set and no larger (#1379).
   */
  readonly statementTimeoutMs?: number;
  /**
   * Refusals of its own, run after the dialect's on every program at runtime (ADR-0037 decision 4). It can only narrow what
   * runs: for an operator running other people's plans. A self-hosted service leaves it out.
   */
  readonly restrict?: RestrictSql;
}

export { postgresDialect };

export function postgresStorage(options: PostgresStorageOptions): MantleStorageAdapter {
  const ms = options.statementTimeoutMs;
  if (ms !== undefined && !(Number.isInteger(ms) && ms >= 0)) throw new RangeError(`statementTimeoutMs must be a whole number of milliseconds (0 is no limit), not ${ms}`);
  return {
    dialect: restricted(postgresDialect(options.timeZone), options.restrict),
    async prepare(plan) {
      const { problems: settings, booted } = await bootRead(options.connect, ms);
      if (settings.length)
        throw new DiagnosticError(settings.map((message) => makeDiagnostic({ code: "STORAGE_CHANGE_BLOCKED", phase: "boot", severity: "error", path: "storage:settings", message })));
      const report = await convergeStorage(options.connect, plan.schemas, { fingerprint: plan.fingerprint, booted });
      if (report.blocked.length)
        throw new DiagnosticError(report.blocked.map((b) => makeDiagnostic({ code: b.code === "STORAGE_TABLE_NOT_OWNED" ? "STORAGE_TABLE_NOT_OWNED" : "STORAGE_CHANGE_BLOCKED", phase: "boot", severity: "error", path: `storage:${b.schema}`, message: b.message })));
      for (const u of report.undeclared) console.warn(`[mantle storage] ${u.code}: ${u.message}`);
      // ponytail: site config and media live on D1 only; a PostgreSQL service that needs them ports d1/site.ts and d1/media.ts
      return { executor: new PgStoreExecutor(options.connect, plan.schemas, checkMessages(plan.schemas), options.statementTimeoutMs) };
    },
  };
}
