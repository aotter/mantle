/** The D1 dialect's runtime side (ADR-0035 decision 6): ADR-0034's subset, SQLite encodings and lowering, and Core's injected policy. */
import type { MantleDialect } from "../core/dialect.js";
import { decodeOutput, encodeInput } from "./codec.js";
import { bindBox, d1Lowering } from "./lower.js";
import { name, version } from "./compile/index.js";
import { validateIr } from "./validator.js";

export const d1Dialect: MantleDialect = {
  name,
  version,
  codec: { encode: encodeInput, decode: decodeOutput },
  check: validateIr,
  lowering: d1Lowering,
  bind: bindBox,
};
