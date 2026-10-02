/** The MantleStorageAdapter for PostgreSQL: converge storage to the plan, then run on `PgConnect` (ADR-0033, ADR-0035). */
import { DiagnosticError, makeDiagnostic } from "../spec/kernel/index.js";
import type { MantleDialect } from "../core/dialect.js";
import type { MantleStorageAdapter } from "../core/service.js";
import { decodeOutput, encodeInput } from "./codec.js";
import { name, version } from "./compile/index.js";
import type { PgConnect } from "./driver.js";
import { PgStoreExecutor } from "./executor.js";
import { pgLowering } from "./lower.js";
import { bindBox } from "../d1/lower.js";
import { checkMessages, convergeStorage } from "./storage.js";
import { validateIr } from "./validator.js";

export interface PostgresStorageOptions {
  /** Opens one connected client: `async () => { const c = new pg.Client(env.HYPERDRIVE.connectionString); await c.connect(); return c; }`. */
  readonly connect: PgConnect;
  /** The site time zone `date_trunc` and `extract` compute in (IANA name). Default UTC. */
  readonly timeZone?: string;
}

/** The PostgreSQL dialect's runtime side over a time zone. */
export function postgresDialect(timeZone = "UTC"): MantleDialect {
  new Intl.DateTimeFormat("en-US", { timeZone }); // an unknown zone throws here, not inside a query
  return {
    name,
    version,
    codec: { encode: encodeInput, decode: decodeOutput },
    check: validateIr,
    lowering: pgLowering(timeZone),
    // the one bind the dialect adds, a corner of a near() box, is D1's (including its refusal of a box across a pole)
    bind: bindBox,
  };
}

export function postgresStorage(options: PostgresStorageOptions): MantleStorageAdapter {
  return {
    dialect: postgresDialect(options.timeZone),
    async prepare(plan) {
      const report = await convergeStorage(options.connect, plan.schemas, { fingerprint: plan.fingerprint });
      if (report.blocked.length)
        throw new DiagnosticError(report.blocked.map((b) => makeDiagnostic({ code: b.code === "STORAGE_TABLE_NOT_OWNED" ? "STORAGE_TABLE_NOT_OWNED" : "STORAGE_CHANGE_BLOCKED", phase: "boot", severity: "error", path: `storage:${b.schema}`, message: b.message })));
      for (const u of report.undeclared) console.warn(`[mantle storage] ${u.code}: ${u.message}`);
      // ponytail: site config and media live on D1 only; a PostgreSQL service that needs them ports d1/site.ts and d1/media.ts
      return { executor: new PgStoreExecutor(options.connect, plan.schemas, checkMessages(plan.schemas)) };
    },
  };
}
