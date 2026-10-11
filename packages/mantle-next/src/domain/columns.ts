/** What a column's Mantle type means to generated code, in one place: Views, Stores and wire forms all read it here. */
import type { RuntimePlan } from "@aotter/mantle/spec";

/** A column's declared type; the two system timestamps are not declared fields. */
export const declaredType = (fields: Readonly<Record<string, string>>, column: string): string | undefined =>
  fields[column] ?? (column === "created_at" || column === "updated_at" ? "timestamptz" : undefined);

/** A View output's declared Mantle type, when the output is a Schema column as it is. Computed outputs have none. */
export function outputType(plan: RuntimePlan, view: string, key: string): string | undefined {
  const columns = plan.views[view]?.columns;
  const field = columns && Object.hasOwn(columns, key) ? columns[key] : undefined;
  const schema = field && plan.schemas[field.schema];
  return schema && declaredType(schema.fields, field!.field);
}

export const scalarType = (type: string) => type === "bool" ? "boolean" : ["integer", "int4", "int8", "real", "float8"].includes(type) ? "number" : type === "json" ? "unknown" : type === "geo" ? "{lat:number;lng:number}" : "string";

/** The driver-native value a column of this type comes back as; declared timestamps and dates arrive as the SQL's wire-form text. */
export const nativeType = (type: string | undefined, sqlite: boolean): string =>
  !type ? "unknown" : ["date", "timestamptz"].includes(type) ? "string" : sqlite
    ? type === "bool" ? "number" : type === "json" ? "string" : scalarType(type)
    : ["integer", "int8"].includes(type) ? "number | string" : scalarType(type);

/** The value a caller of the typed Store passes for a column of this type. */
export const inputType = (type: string): string => type === "timestamptz" ? "string | Date" : scalarType(type);
