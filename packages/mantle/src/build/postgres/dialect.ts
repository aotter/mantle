/** PostgreSQL build-time validation, policy lowering and printing. */
import type { MantleDialect } from "../core/dialect.js";
import { pgLowering } from "./lower.js";
import { print, typed } from "./print.js";
import { validateIr, validateProgram } from "./validator.js";

/** Compile PostgreSQL SQL for a named time zone. */
export function postgresDialect(timeZone = "UTC"): MantleDialect {
  new Intl.DateTimeFormat("en-US", { timeZone }); // an unknown zone throws here, not inside a query
  // PostgreSQL reads '+08:00' as POSIX (eight hours west), Intl as eight hours east: only a named zone means the same to both
  if (/^[+-]|^(utc|gmt)[+-]/i.test(timeZone))
    throw new RangeError(`timeZone must be an IANA name such as Asia/Taipei, not the offset ${timeZone}`);
  // `version` changes when what a PostgreSQL plan means changes (ADR-0035 decision 5)
  return {
    name: "@aotter/mantle/postgres",
    version: "2",
    accepts: validateProgram,
    check: validateIr,
    lowering: pgLowering(timeZone),
    nativeOrder: true,
    nativeSql: true,
    // the executor prints `typed` then the deparser (ADR-0044 decision 3)
    print: (ast, schemas) => print(typed(ast, schemas)),
  };
}
