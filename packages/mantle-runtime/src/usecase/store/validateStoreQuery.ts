import { DiagnosticError, runtimeDiagnostic, type SchemaManifest } from "@aotter/mantle-spec";
import type { StoreSelect, StoreWhere } from "../../domain/model/Store.js";

const NATIVE_TYPES: Readonly<Record<string, string>> = {
  id: "string", status: "string", version: "integer", createdAt: "integer", updatedAt: "integer", authorId: "string",
};
const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "isNull"]);

/** Validate caller input before it reaches any storage adapter. */
export function validateStoreSelect(query: StoreSelect, schemas: ReadonlyMap<string, SchemaManifest>, callerId?: string, callerBound = false): StoreSelect {
  if (!record(query)) throw invalid("Store select takes an object.");
  unknownKey(query, ["from", "columns", "where", "orderBy", "limit", "cursor"], "Store select");
  const schema = requireSchema(query.from, schemas);
  if (query.columns !== undefined) {
    if (!Array.isArray(query.columns) || !query.columns.length) throw invalid("Store columns takes a non-empty array.");
    for (const column of query.columns) columnType(schema, column, "columns", false);
  }
  const orderBy = query.orderBy ?? { updatedAt: "desc" };
  if (!record(orderBy) || Object.keys(orderBy).length !== 1) throw invalid("Store orderBy takes exactly one column.");
  for (const [column, direction] of Object.entries(orderBy)) {
    columnType(schema, column, "orderBy", true);
    if (direction !== "asc" && direction !== "desc") throw invalid(`orderBy '${column}' must be 'asc' or 'desc'.`);
  }
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500)) {
    throw invalid("Store limit must be an integer from 1 to 500.");
  }
  if (query.cursor !== undefined && typeof query.cursor !== "string") throw invalid("Store cursor must be a string.");
  if (query.where !== undefined) validateStoreWhere(query.where, schema, schemas);
  const [sortField, direction] = Object.entries(orderBy)[0]!;
  const where = callerBound ? scopeStoreWhere(query.where, schema, schemas, callerId)
    : query.where === undefined ? undefined : structuredClone(query.where);
  return {
    from: query.from,
    ...(query.columns === undefined ? {} : { columns: [...new Set(query.columns)] }),
    ...(where === undefined ? {} : { where }),
    orderBy: { [sortField]: direction as "asc" | "desc" },
    limit: query.limit ?? 50,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

/** Add the caller predicate outside each user expression, including subqueries. */
export function scopeStoreWhere(
  where: StoreWhere | undefined,
  schema: SchemaManifest,
  schemas: ReadonlyMap<string, SchemaManifest>,
  callerId: string | undefined,
): StoreWhere | undefined {
  const field = Object.keys(schema.spec.scope ?? {})[0];
  if (field && !callerId) throw invalid(`Schema '${schema.metadata.name}' requires a caller identity.`);
  const mapped = where && scopeSubqueries(where, schemas, callerId);
  if (!field) return mapped;
  const scoped = { [field]: callerId! };
  return mapped ? { and: [mapped, scoped] } : scoped;
}

function scopeSubqueries(where: StoreWhere, schemas: ReadonlyMap<string, SchemaManifest>, callerId: string | undefined): StoreWhere {
  return Object.fromEntries(Object.entries(where).map(([key, value]) => {
    if (key === "and" || key === "or") return [key, (value as readonly StoreWhere[]).map((child) => scopeSubqueries(child, schemas, callerId))];
    if (key === "not") return [key, scopeSubqueries(value as StoreWhere, schemas, callerId)];
    return [key, scopeComparison(value, schemas, callerId)];
  })) as StoreWhere;
}

function scopeComparison(value: unknown, schemas: ReadonlyMap<string, SchemaManifest>, callerId: string | undefined): unknown {
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([operator, operand]) => {
    if ((operator === "in" || operator === "notIn") && record(operand)) {
      const schema = requireSchema(operand["from"], schemas);
      const where = scopeStoreWhere(operand["where"] as StoreWhere | undefined, schema, schemas, callerId);
      return [operator, { select: operand["select"], from: operand["from"], ...(where === undefined ? {} : { where }) }];
    }
    return [operator, operand];
  }));
}

export function validateStoreWhere(
  where: StoreWhere,
  schema: SchemaManifest,
  schemas: ReadonlyMap<string, SchemaManifest>,
  budget = { nodes: 0 },
  depth = 0,
): void {
  if (depth > 16) throw invalid("Store where nests deeper than 16.");
  spend(budget);
  if (!record(where)) throw invalid("A Store where condition must be an object.");
  const entries = Object.entries(where);
  if (!entries.length) throw invalid("A Store where condition must not be empty.");
  for (const [column, value] of entries) {
    if (value === undefined) throw invalid(`Store where '${column}' is undefined; omit the key or use isNull.`);
    if (column === "and" || column === "or") {
      if (!Array.isArray(value) || !value.length) throw invalid(`'${column}' takes a non-empty array.`);
      for (const child of value) validateStoreWhere(child, schema, schemas, budget, depth + 1);
      continue;
    }
    if (column === "not") {
      validateStoreWhere(value as StoreWhere, schema, schemas, budget, depth + 1);
      continue;
    }
    const type = columnType(schema, column, "a where", true);
    if (!record(value)) {
      checkValue(column, "eq", value, type);
      continue;
    }
    const comparisons = Object.entries(value);
    if (!comparisons.length) throw invalid(`Column '${column}' has an empty comparison.`);
    for (const [operator, operand] of comparisons) {
      if (operand === undefined) throw invalid(`'${operator}' on '${column}' is undefined; omit it or use isNull.`);
      if (!OPERATORS.has(operator)) throw invalid(`Unknown Store operator '${operator}' on '${column}'.`);
      spend(budget);
      if (operator === "isNull") {
        if (typeof operand !== "boolean") throw invalid(`'isNull' on '${column}' takes a boolean.`);
      } else if (operator === "in" || operator === "notIn") {
        if (Array.isArray(operand)) {
          for (const item of operand) {
            if (item === null) throw invalid(`'${operator}' on '${column}' cannot contain null; use isNull.`);
            checkValue(column, operator, item, type);
          }
        } else {
          if (!record(operand)) throw invalid("'in' / 'notIn' take an array or a { select, from, where } subquery.");
          unknownKey(operand, ["select", "from", "where"], "subquery");
          spend(budget);
          const inner = requireSchema(operand["from"], schemas);
          columnType(inner, operand["select"], "a subquery select", true);
          if (operand["where"] !== undefined) validateStoreWhere(operand["where"] as StoreWhere, inner, schemas, budget, depth + 1);
        }
      } else {
        checkValue(column, operator, operand, type);
      }
    }
  }
}

function requireSchema(name: unknown, schemas: ReadonlyMap<string, SchemaManifest>): SchemaManifest {
  const schema = typeof name === "string" ? schemas.get(name) : undefined;
  if (!schema) throw invalid(`Unknown Schema '${String(name)}'.`);
  return schema;
}

function columnType(schema: SchemaManifest, column: unknown, purpose: string, scalar: boolean): string {
  if (typeof column !== "string") throw invalid(`${purpose} must name a column.`);
  if (Object.hasOwn(NATIVE_TYPES, column)) return NATIVE_TYPES[column]!;
  const property = schema.spec.schema.properties?.[column];
  if (!property) throw invalid(`Schema '${schema.metadata.name}' has no column '${column}'.`);
  const types = [...new Set((typeof property.type === "string" ? [property.type] : property.type ?? []).filter((type) => type !== "null"))];
  const type = types.length === 1 && !property.oneOf ? types[0]! : "json";
  if (scalar && !["string", "number", "integer", "boolean"].includes(type)) {
    throw invalid(`Column '${column}' is not a scalar and cannot be used in ${purpose}.`);
  }
  return type;
}

function checkValue(column: string, operator: string, value: unknown, type: string): void {
  if (value === null) {
    if (!["eq", "ne"].includes(operator)) throw invalid(`'${operator}' on '${column}' cannot compare with null.`);
    return;
  }
  const ok = type === "boolean" ? typeof value === "boolean"
    : type === "string" ? typeof value === "string"
      : typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isSafeInteger(value));
  if (!ok) throw invalid(`'${operator}' on '${column}' expects a value of type ${type}.`);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const key = Object.keys(value).find((name) => !allowed.includes(name));
  if (key) throw invalid(label === "subquery" ? `Unknown subquery key '${key}'.` : `Unknown ${label} key '${key}'.`);
}

function spend(budget: { nodes: number }): void {
  if (++budget.nodes > 256) throw invalid("Store where has more than 256 conditions.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({ code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message }));
}
