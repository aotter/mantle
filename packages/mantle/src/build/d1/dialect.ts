/** SQLite build-time validation, policy lowering and printing. */
import type { MantleDialect } from "../core/dialect.js";
import { d1Lowering } from "./lower.js";
import { name, version } from "./compile/index.js";
import { print } from "./print.js";
import { validateIr } from "./validator.js";

export const d1Dialect: MantleDialect = {
  name,
  version,
  check: validateIr,
  lowering: d1Lowering,
  print: (ast) => print(ast),
};
