/** SQLite build-time validation, policy lowering and printing. */
import type { MantleDialect } from "../core/dialect.js";
import { d1Lowering } from "./lower.js";
import { print } from "./print.js";
import { validateIr, validateProgram } from "./validator.js";

/** `version` changes when what a D1 plan means changes (ADR-0035 decision 5). */
export const d1Dialect: MantleDialect = {
  name: "@aotter/mantle/d1",
  version: "1",
  accepts: validateProgram,
  check: validateIr,
  lowering: d1Lowering,
  print: (ast) => print(ast),
};
