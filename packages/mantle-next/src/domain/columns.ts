/** What a column's Mantle type means to generated code, in one place: Views, Stores and wire forms all read it here. */
import { viewOutputs, type RuntimePlan } from "@aotter/mantle/compiler";
import type { Target } from "./model.js";
import type { WireColumns } from "../kernel/contracts.js";

/** A column's declared type, including the system version and timestamps. @internal */
export const declaredType = (fields: Readonly<Record<string, string>>, column: string): string | undefined =>
  fields[column] ?? (column === "version" ? "integer" : column === "created_at" || column === "updated_at" || column === "published_at" ? "timestamptz" : undefined);

/** Compiler-owned schema type metadata, including aggregates that inherit a field's presentation type. @internal */
export function outputType(plan: RuntimePlan, view: string, key: string): string | undefined {
  const columns = plan.views[view]?.columns;
  const field = columns && Object.hasOwn(columns, key) ? columns[key] : undefined;
  const schema = field && plan.schemas[field.schema];
  return schema && declaredType(schema.fields, field!.field);
}

/** Declared output lineage only; computed columns retain their native values. */
export function outputConversions(plan: RuntimePlan, view: string, target: Target): WireColumns {
  const postgres = target.endsWith("postgres");
  const columns = viewOutputs(plan.views[view]!, plan.schemas, new Map(), false, false).columns;
  return Object.keys(columns).flatMap<WireColumns[number]>(key => {
    const type = outputType(plan, view, key);
    return postgres ? type && ["integer", "int8", "int4"].includes(type) ? [[key, "int"]] : []
      : type === "json" || type === "bool" ? [[key, type]] : [];
  });
}

/** Wrap a selected page; the generated bare operation is unchanged. */
export const boundaryPage = (page: string, fields: WireColumns): string => fields.length
  ? `(db, caller, input, paging) => ${page}(db, caller, input, paging).then(page => ({ ...page, rows: wireRows(page.rows, ${JSON.stringify(fields)}) }))` : page;

const scalarType = (type: string) => type === "bool" ? "boolean" : ["integer", "int4", "int8", "real", "float8"].includes(type) ? "number" : type === "json" ? "unknown" : type === "geo" ? "{lat:number;lng:number}" : "string";

/**
 * The driver-native value a column of this type comes back as, `| null` unless `notNull`; declared timestamps and dates arrive as the
 * SQL's wire-form text. A column with no declared type (a computed output) is `unknown`, which already includes null. @internal
 */
export function nativeType(type: string | undefined, sqlite: boolean, notNull = false): string {
  const native = !type ? "unknown" : ["date", "timestamptz"].includes(type) ? "string" : sqlite
    ? type === "bool" ? "number" : type === "json" ? "string" : scalarType(type)
    : ["integer", "int8"].includes(type) ? "number | string | bigint" : scalarType(type);
  return notNull || native === "unknown" ? native : `${native} | null`;
}

/** The value a caller of the typed Store passes for a column of this type. JSON is an object or array (the Store tells it by its JS type, so a bare string would be bound as text). @internal */
export const inputType = (type: string): string => type === "timestamptz" ? "string | Date" : type === "json" ? "object" : scalarType(type);
