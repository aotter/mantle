import type { RuntimePlan } from "../spec/domain/index.js";
import type { MantleDialect } from "../core/dialect.js";
import { lowerReaderSeeds } from "../core/store/readerSeeds.js";

/** Source data, never eval: runtime adopts only the shape used by a successful reader request. */
export function emitReaderSeeds(plan: RuntimePlan, dialect: MantleDialect): string {
  const names = new Map<object, string>();
  const declarations: string[] = [];
  const entries = Object.entries(lowerReaderSeeds(plan.schemas, dialect)).map(([key, seed]) => {
    let name = names.get(seed);
    if (!name) {
      name = `readerSeed${names.size}`;
      names.set(seed, name);
      declarations.push(`const ${name} = ${JSON.stringify(seed, null, 2)} as const;`);
    }
    return `  [${JSON.stringify(key)}]: ${name},`;
  });
  return [...declarations, "export const readerSeeds = {", ...entries, "} as const;", ""].join("\n");
}
