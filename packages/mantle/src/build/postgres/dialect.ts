/** The PostgreSQL dialect's runtime side (ADR-0035). Its own file so `mantle generate` can lower a plan without the storage adapter (ADR-0044). */
import type { MantleDialect } from "../core/dialect.js";
import { bindBox } from "../d1/lower.js";
import { decodeOutput, encodeInput } from "./codec.js";
import { name, version } from "./compile/index.js";
import { pgLowering } from "./lower.js";
import { print, typed } from "./print.js";
import { validateIr } from "./validator.js";

/** The PostgreSQL dialect's runtime side over a time zone. */
export function postgresDialect(timeZone = "UTC"): MantleDialect {
  new Intl.DateTimeFormat("en-US", { timeZone }); // an unknown zone throws here, not inside a query
  // PostgreSQL reads '+08:00' as POSIX (eight hours west), Intl as eight hours east: only a named zone means the same to both
  if (/^[+-]|^(utc|gmt)[+-]/i.test(timeZone)) throw new RangeError(`timeZone must be an IANA name such as Asia/Taipei, not the offset ${timeZone}`);
  return {
    name,
    version,
    codec: { encode: encodeInput, decode: decodeOutput },
    check: validateIr,
    lowering: pgLowering(timeZone),
    nativeOrder: true,
    nativeSql: true,
    // the one bind the dialect adds, a corner of a near() box, is D1's (including its refusal of a box across a pole)
    bind: bindBox,
    // the executor prints `typed` then the deparser (ADR-0044 decision 3); `lowerKey` carries what the text embeds besides the dialect: the zone
    print: (ast, schemas) => print(typed(ast, schemas)),
    lowerKey: timeZone,
  };
}

