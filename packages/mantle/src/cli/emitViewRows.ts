/** Emit named View projection/decoding from the sealed plan; codecs remain dialect-owned. */
import { NATIVE_OUTPUT_TYPES, parseNumeric, viewOutputs, type RuntimePlan } from "../spec/index.js";

export function emitViewRows(plan: RuntimePlan): string {
  const dialect = plan.lowered?.dialect.name;
  const sqlite = dialect === "@aotter/mantle/d1";
  const postgres = dialect === "@aotter/mantle/postgres";
  let helpers = false;
  const helper = (name: string, args = "value") => { helpers = true; return `rowCodec.${name}(${args})`; };
  const decode = (type: string | undefined, value: string): string => {
    if (!sqlite && !postgres) return `codec.decode(${JSON.stringify(type)}, ${value})`;
    const numeric = type === undefined ? undefined : parseNumeric(type);
    let decoded = "value";
    if (numeric) decoded = postgres
      ? `typeof value === "number" ? ${helper("decodeNumeric", `Math.round(value * 10 ** ${numeric.s}), ${numeric.s}`)} : String(value)`
      : helper("decodeNumeric", `value, ${numeric.s}`);
    else if (type === "bool") decoded = postgres ? 'typeof value === "boolean" ? value : value === 1' : "value === 1";
    else if (type === "timestamptz") decoded = postgres ? `typeof value === "number" ? ${helper("decodeTimestamptz")} : value` : helper("decodeTimestamptz");
    else if (sqlite && type === "date") decoded = helper("decodeDate");
    else if (sqlite && type === "json") decoded = helper("decodeJson");
    // Read once, preserving getters, NULL handling and left-to-right error order.
    return `(value = ${value}, value == null ? null : ${decoded})`;
  };
  const views = Object.entries(plan.views).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const rows = views.flatMap(([name, view]) => {
    const { keys } = viewOutputs(view, plan.schemas);
    if (!keys) return [];
    const fields: string[] = [];
    const seen = new Set<string>();
    let typed = false;
    for (const key of keys) {
      const c = view.columns && Object.hasOwn(view.columns, key) ? view.columns[key] : undefined;
      const schema = c && plan.schemas[c.schema];
      const type = schema ? Object.hasOwn(schema.fields, c!.field) ? schema.fields[c!.field] : NATIVE_OUTPUT_TYPES[c!.field] : undefined;
      const output = schema && key === c!.field ? schema.names?.[c!.field] ?? key : key;
      const value = `row[${JSON.stringify(key)}]`;
      const field = `[${JSON.stringify(output)}]: ${schema ? decode(type, value) : value}`;
      if (schema && (sqlite || postgres)) typed = true;
      // Preserve decode order and last-write wins for declared-name collisions without duplicate TS properties.
      fields.push(`    ${seen.has(output) ? `...{ ${field} }` : field},`);
      seen.add(output);
    }
    return [`  [${JSON.stringify(name)}]: (row: StoreRow, codec: StoreCodec): StoreRow => {`, ...(typed ? ["    let value: any;"] : []), "    return {", ...fields, "    };", "  },"];
  });
  return [...(helpers ? [`import * as rowCodec from ${JSON.stringify(dialect)};`, ""] : []), "export const viewRows = {", ...rows, "};"].join("\n");
}
