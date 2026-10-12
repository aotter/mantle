/** What a column's Mantle type means to generated code, in one place: Views, Stores and wire forms all read it here. */
import type { RuntimePlan } from "@aotter/mantle/compiler";
import type { Target } from "./model.js";
import type { WireColumns } from "../kernel/contracts.js";

/** A column's declared type; the two system timestamps are not declared fields. @internal */
export const declaredType = (fields: Readonly<Record<string, string>>, column: string): string | undefined =>
  fields[column] ?? (column === "version" ? "integer" : column === "created_at" || column === "updated_at" || column === "published_at" ? "timestamptz" : undefined);

/** A View output's declared Mantle type, when the output is a Schema column as it is. Computed outputs have none. @internal */
export function outputType(plan: RuntimePlan, view: string, key: string): string | undefined {
  const columns = plan.views[view]?.columns;
  const field = columns && Object.hasOwn(columns, key) ? columns[key] : undefined;
  const schema = field && plan.schemas[field.schema];
  return schema && declaredType(schema.fields, field!.field);
}

/** Static declared transport conversions; computed outputs retain their native values. */
export function outputConversions(plan: RuntimePlan, view: string, target: Target): WireColumns {
  if (target.endsWith("postgres")) return [];
  return Object.keys(plan.views[view]?.columns ?? {}).flatMap<WireColumns[number]>(key => {
    const type = outputType(plan, view, key);
    return type === "json" || type === "bool" ? [[key, type] as const] : [];
  });
}

const scalarType = (type: string) => type === "bool" ? "boolean" : ["integer", "int4", "int8", "real", "float8"].includes(type) ? "number" : type === "json" ? "unknown" : type === "geo" ? "{lat:number;lng:number}" : "string";

/**
 * The column's output, `| null` unless `notNull`; SQL preserves declared integers and formats timestamps/dates.
 * A column with no declared type (a computed output) is `unknown`, which already includes null. @internal
 */
export function nativeType(type: string | undefined, sqlite: boolean, notNull = false): string {
  const native = !type ? "unknown" : ["integer", "int4", "int8"].includes(type) ? "number | string" : ["date", "timestamptz"].includes(type) ? "string" : sqlite
    ? type === "bool" ? "number" : type === "json" ? "string" : scalarType(type)
    : scalarType(type);
  return notNull || native === "unknown" ? native : `${native} | null`;
}

/** The value a caller of the typed Store passes for a column of this type. JSON is an object or array (the Store tells it by its JS type, so a bare string would be bound as text). @internal */
export const inputType = (type: string): string => type === "timestamptz" ? "string | Date" : type === "json" ? "object" : scalarType(type);

/** A selected boundary page converts only its static declared output columns. */
export const boundaryPage = (page: string, fields: ReturnType<typeof outputConversions>): string => fields.length
  ? `(db, caller, input, paging) => ${page}(db, caller, input, paging).then(page => ({ ...page, rows: wireRows(page.rows, ${JSON.stringify(fields)}) }))` : page;
