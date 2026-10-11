import type { RuntimePlan } from "../spec/domain/index.js";
import type { MantleDialect } from "../core/dialect.js";
import { lowerReaderSeeds } from "../core/store/readerSeeds.js";

/** Source data, never eval: runtime adopts only the shape used by a successful reader request. */
export function emitReaderSeeds(plan: RuntimePlan, dialect: MantleDialect): string {
  return `export const readerSeeds = ${JSON.stringify(lowerReaderSeeds(plan.schemas, dialect), null, 2)} as const;\n`;
}
