import { DiagnosticError, runtimeDiagnostic, type SchemaManifest } from "@aotter/mantle-spec";
import type { StoreScalar, StoreSelect, StoreSubquery, StoreWhere } from "../../domain/model/Store.js";
import { encodeField, fieldCodec, fieldColumn, isNullableJsonSchema, sqliteSchemaTable, type SqliteSchemaTable } from "../storage/SqliteSchemaTables.js";

/** D1 binds at most 100 parameters per statement; keep every compiled Store statement under it. */
export const STORE_MAX_BINDS = 100;
const MAX_DEPTH = 16;
/** Bounds statement size across and/or width and nested subqueries. */
const MAX_NODES = 256;
const COMPARISONS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "isNull"]);
const NATIVE_TYPES: Readonly<Record<string, "string" | "integer">> = {
  id: "string", status: "string", version: "integer", createdAt: "integer", updatedAt: "integer", authorId: "string",
};

export interface CompiledSql {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

/**
 * Compiles the closed Store where AST (ADR-0030) against one Schema table.
 * Every value is bound; identifiers come only from the linked Schema.
 * `live` supplies each table's TTL visibility condition.
 */
export class SqliteStoreQueryCompiler {
  constructor(
    private readonly schemasByName: ReadonlyMap<string, SchemaManifest>,
    private readonly live: (table: SqliteSchemaTable) => CompiledSql | null,
  ) {}

  table(collection: unknown): SqliteSchemaTable {
    const schema = typeof collection === "string" ? this.schemasByName.get(collection) : undefined;
    if (!schema) throw invalid(`Unknown Schema '${String(collection)}'.`);
    return sqliteSchemaTable(schema);
  }

  /** The physical column for a native or scalar Schema column. */
  column(table: SqliteSchemaTable, column: unknown, purpose: string): string {
    if (typeof column !== "string") throw invalid(`${purpose} must name a column.`);
    const physical = fieldColumn(table.schema, column);
    if (!physical) throw invalid(`Schema '${table.schema.metadata.name}' has no column '${column}'.`);
    if (!Object.hasOwn(NATIVE_TYPES, column) && fieldCodec(this.property(table, column)) === "json") {
      throw invalid(`Column '${column}' is not a scalar and cannot be used in ${purpose}.`);
    }
    return quote(physical);
  }

  /** A scalar column to order by; NULLs sort last in either direction. */
  orderColumn(table: SqliteSchemaTable, column: unknown): string {
    return this.column(table, column, "orderBy");
  }

  /**
   * WHERE body for `where` plus the table's TTL visibility; `1 = 1` when empty.
   * `budget` carries nesting depth and the statement-wide node count into subqueries.
   */
  where(table: SqliteSchemaTable, where: StoreWhere | undefined, budget: Budget = newBudget()): CompiledSql {
    const parts: string[] = [];
    const binds: unknown[] = [];
    if (where !== undefined) {
      const compiled = this.node(table, where, budget.depth, budget);
      parts.push(compiled.sql);
      binds.push(...compiled.binds);
    }
    const live = this.live(table);
    if (live) { parts.push(live.sql); binds.push(...live.binds); }
    return { sql: parts.length ? parts.map((part) => `(${part})`).join(" AND ") : "1 = 1", binds };
  }

  private node(table: SqliteSchemaTable, where: unknown, depth: number, budget: Budget): CompiledSql {
    if (depth > MAX_DEPTH) throw invalid(`Store where nests deeper than ${MAX_DEPTH}.`);
    spend(budget);
    if (!isPlainObject(where)) throw invalid("A Store where condition must be an object.");
    const entries = Object.entries(where).filter(([, value]) => value !== undefined);
    if (!entries.length) throw invalid("A Store where condition must not be empty.");
    const parts: string[] = [];
    const binds: unknown[] = [];
    for (const [key, value] of entries) {
      let compiled: CompiledSql;
      if (key === "and" || key === "or") {
        if (!Array.isArray(value) || value.length === 0) throw invalid(`'${key}' takes a non-empty array.`);
        const children = value.map((child) => this.node(table, child, depth + 1, budget));
        compiled = {
          sql: children.map((child) => `(${child.sql})`).join(key === "and" ? " AND " : " OR "),
          binds: children.flatMap((child) => child.binds),
        };
      } else if (key === "not") {
        const child = this.node(table, value, depth + 1, budget);
        compiled = { sql: `NOT (${child.sql})`, binds: child.binds };
      } else {
        compiled = this.comparison(table, key, value, depth, budget);
      }
      parts.push(compiled.sql);
      binds.push(...compiled.binds);
    }
    return { sql: parts.map((part) => `(${part})`).join(" AND "), binds };
  }

  private comparison(table: SqliteSchemaTable, column: string, value: unknown, depth: number, budget: Budget): CompiledSql {
    const sql = this.column(table, column, "a where");
    if (!isPlainObject(value)) return this.operator(table, column, sql, "eq", value, depth, budget);
    const operators = Object.entries(value).filter(([, operand]) => operand !== undefined);
    if (!operators.length) throw invalid(`Column '${column}' has an empty comparison.`);
    const parts = operators.map(([operator, operand]) => this.operator(table, column, sql, operator, operand, depth, budget));
    return { sql: parts.map((part) => part.sql).join(" AND "), binds: parts.flatMap((part) => part.binds) };
  }

  private operator(table: SqliteSchemaTable, column: string, sql: string, operator: string, operand: unknown, depth: number, budget: Budget): CompiledSql {
    if (!COMPARISONS.has(operator)) throw invalid(`Unknown Store operator '${operator}' on '${column}'.`);
    spend(budget);
    if (operator === "isNull") {
      if (typeof operand !== "boolean") throw invalid(`'isNull' on '${column}' takes a boolean.`);
      return { sql: `${sql} IS ${operand ? "" : "NOT "}NULL`, binds: [] };
    }
    if (operator === "in" || operator === "notIn") {
      const negate = operator === "notIn";
      if (Array.isArray(operand)) {
        if (!operand.length) return { sql: negate ? "1 = 1" : "0 = 1", binds: [] };
        const values = operand.map((item) => this.value(table, column, item, operator));
        if (values.some((item) => item === null)) throw invalid(`'${operator}' on '${column}' cannot contain null; use isNull.`);
        return { sql: `${sql} ${negate ? "NOT IN" : "IN"} (${values.map(() => "?").join(", ")})`, binds: values };
      }
      const sub = this.subquery(operand, depth, budget);
      return { sql: `${sql} ${negate ? "NOT IN" : "IN"} (${sub.sql})`, binds: sub.binds };
    }
    const bound = this.value(table, column, operand, operator);
    if (bound === null) {
      if (operator === "eq") return { sql: `${sql} IS NULL`, binds: [] };
      if (operator === "ne") return { sql: `${sql} IS NOT NULL`, binds: [] };
      throw invalid(`'${operator}' on '${column}' cannot compare with null.`);
    }
    const symbol = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[operator as "eq"];
    // `ne` keeps NULL rows out, matching SQL; ask for them explicitly with `or` + `isNull`.
    return { sql: `${sql} ${symbol} ?`, binds: [bound] };
  }

  private subquery(operand: unknown, depth: number, budget: Budget): CompiledSql {
    if (!isPlainObject(operand)) throw invalid("'in' / 'notIn' take an array or a { select, from, where } subquery.");
    const unknownKey = Object.keys(operand).find((key) => !["select", "from", "where"].includes(key));
    if (unknownKey) throw invalid(`Unknown subquery key '${unknownKey}'.`);
    const { select, from, where } = operand as unknown as StoreSubquery;
    spend(budget);
    const table = this.table(from);
    const column = this.column(table, select, "a subquery select");
    // Unqualified columns resolve to the innermost table. NULLs are excluded so
    // `notIn` keeps SQL's "unknown" out of the result, matching the array form.
    const body = this.where(table, where, { depth: depth + 1, shared: budget.shared });
    return { sql: `SELECT ${column} FROM ${table.table} WHERE ${column} IS NOT NULL AND (${body.sql})`, binds: body.binds };
  }

  private value(table: SqliteSchemaTable, column: string, value: unknown, operator: string): unknown {
    if (value === null) return null;
    const type = NATIVE_TYPES[column] ?? fieldCodec(this.property(table, column));
    const ok = type === "boolean" ? typeof value === "boolean"
      : type === "string" ? typeof value === "string"
        : typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isSafeInteger(value));
    if (!ok) throw invalid(`'${operator}' on '${column}' expects a value of type ${type}.`);
    return Object.hasOwn(NATIVE_TYPES, column) ? value : encodeField(value, this.property(table, column));
  }

  private property(table: SqliteSchemaTable, column: string) {
    return table.schema.spec.schema.properties![column]!;
  }
}

/** Nesting depth is per path; the node count is shared by the whole statement. */
interface Budget { readonly depth: number; readonly shared: { nodes: number } }
const newBudget = (): Budget => ({ depth: 0, shared: { nodes: 0 } });
/** Every where object, comparison and subquery counts, so compiled SQL stays bounded. */
function spend(budget: Budget): void {
  if (++budget.shared.nodes > MAX_NODES) throw invalid(`Store where has more than ${MAX_NODES} conditions.`);
}

export function assertBindBudget(compiled: CompiledSql): void {
  if (compiled.binds.length > STORE_MAX_BINDS) {
    throw invalid(`A Store statement may bind at most ${STORE_MAX_BINDS} values; use a subquery instead of a long 'in' list.`);
  }
}

export function validateSelect(query: StoreSelect): void {
  if (!isPlainObject(query)) throw invalid("Store select takes an object.");
  const unknownKey = Object.keys(query).find((key) => !["from", "columns", "where", "orderBy", "limit", "cursor"].includes(key));
  if (unknownKey) throw invalid(`Unknown Store select key '${unknownKey}'.`);
}

export function invalid(message: string): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({
    code: "INPUT_VALIDATION_FAILED", severity: "error", path: "store", message,
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export type { StoreScalar };
