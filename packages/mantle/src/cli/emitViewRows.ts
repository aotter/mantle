/** Emit named View projection/decoding from the sealed plan; codecs remain dialect-owned. */
import { NATIVE_OUTPUT_TYPES, viewOutputs, type RuntimePlan } from "../spec/index.js";

export function emitViewRows(plan: RuntimePlan): string {
  const views = Object.entries(plan.views).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const rows = views.flatMap(([name, view]) => {
    const { keys } = viewOutputs(view, plan.schemas);
    if (!keys) return [];
    const fields: string[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const c = view.columns && Object.hasOwn(view.columns, key) ? view.columns[key] : undefined;
      const schema = c && plan.schemas[c.schema];
      const type = schema ? Object.hasOwn(schema.fields, c!.field) ? schema.fields[c!.field] : NATIVE_OUTPUT_TYPES[c!.field] : undefined;
      const output = schema && key === c!.field ? schema.names?.[c!.field] ?? key : key;
      const value = `row[${JSON.stringify(key)}]`;
      const field = `[${JSON.stringify(output)}]: ${schema ? `codec.decode(${JSON.stringify(type)}, ${value})` : value}`;
      // Preserve decode order and last-write wins for declared-name collisions without duplicate TS properties.
      fields.push(`    ${seen.has(output) ? `...{ ${field} }` : field},`);
      seen.add(output);
    }
    return [`  [${JSON.stringify(name)}]: (row: StoreRow, codec: StoreCodec): StoreRow => ({`, ...fields, "  }),"];
  });
  return ["export const viewRows = {", ...rows, "};"].join("\n");
}
