import {
  DiagnosticError,
  RESERVED_ENTRY_COLUMNS,
  isCtxUserRef,
  isParamRef,
  runtimeDiagnostic,
  schemaIndexedFieldSql,
  type FilterAst,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";
import { clampPage, clampShow } from "./Pagination.js";
import {
  compileLogicalView,
  type LogicalViewPlan,
} from "./RuntimePlanCompiler.js";

/**
 * View → SQL compilation. Targets SQLite + JSON1 (D1's dialect).
 * Reserved metadata fields project as native columns. Declared Schema
 * index fields use their generated columns; undeclared fields keep the
 * `json_extract(data, '$.<field>')` fallback. SQL uses positional `?`
 * parameters; field-name escapes are defense-in-depth on top of the
 * Schema validator gate.
 *
 * v0.1 filter AST supports comparison operators (`eq`, `gt`, `gte`,
 * `lt`, `lte`) plus `and` / `or`; comparison values may be literals or
 * `{ $param: <name> }` sentinels substituted from `options.params`, plus
 * `{ "$ctx.user": "id" }` bound from the normalized site caller. Pagination
 * knobs `page` / `show` come in via
 * `options`; the runtime owns the LIMIT/OFFSET emission.
 */
export interface CompiledView {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly effectivePage: number;
  readonly effectiveShow: number;
}

export interface CompileViewOptions {
  /** Resolved query-string params, post-coercion. */
  readonly params?: Record<string, unknown>;
  /** 1-indexed; non-positive / non-finite falls back to 1. */
  readonly page?: number;
  /** Caller's requested page size; clamped to View.spec.limit. */
  readonly show?: number;
  /** Site-local Better Auth user id for identity-bound filters. */
  readonly ctxUserId?: string;
  /** Admin-only substring search over manifest-allowlisted output fields. */
  readonly search?: { readonly term: string; readonly fields: readonly string[] };
  /** Admin-only exact filters over manifest-allowlisted output fields. */
  readonly filters?: ReadonlyArray<{ readonly field: string; readonly value: string }>;
}

// alias → SQL column. Aliases mirror RESERVED_ENTRY_COLUMNS from
// spec; SQL column shape (snake_case) is local to the storage layout.
// The compile-time check below ensures the alias set stays in sync —
// adding to spec without updating here is a type error.
const RESERVED_COLUMN: Readonly<Record<string, string>> = {
  id: "id",
  status: "status",
  version: "version",
  createdAt: "created_at",
  updatedAt: "updated_at",
  authorId: "author_id",
};
const _aliasCheck: Readonly<Record<(typeof RESERVED_ENTRY_COLUMNS)[number], string>> =
  RESERVED_COLUMN;
void _aliasCheck;

const DEFAULT_PROJECTION = Object.entries(RESERVED_COLUMN)
  .map(([alias, col]) => (alias === col ? col : `${col} AS ${alias}`))
  .join(", ");

type FilterComparisonOp = "eq" | "gt" | "gte" | "lt" | "lte";
interface FilterComparisonNode {
  readonly field: string;
  readonly value: unknown;
}

const SQL_COMPARISON_OP: Readonly<Record<FilterComparisonOp, string>> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export function compileView(
  view: ViewManifest,
  options: CompileViewOptions = {},
  schema?: SchemaManifest,
): CompiledView {
  return lowerView(compileLogicalView(view), view.metadata.name, options, schema);
}

/** SQLite lowering of the compiler-owned logical View descriptor. */
export function lowerView(
  view: LogicalViewPlan,
  viewName: string,
  options: CompileViewOptions = {},
  schema?: SchemaManifest,
): CompiledView {
  if (view.kind === "native") return compileSqlView(view, options);
  if (schema && schema.metadata.name !== view.from) {
    throw new DiagnosticError(
      runtimeDiagnostic({
        code: "INTERNAL_ERROR",
        severity: "error",
        path: "compileView/schema",
        value: schema.metadata.name,
        expected: `Schema '${view.from}' referenced by View.spec.from`,
        message: `View '${viewName}' cannot compile against Schema '${schema.metadata.name}'.`,
      }),
    );
  }
  const sqlParams: unknown[] = [view.from];
  const selectExpr = buildSelect(view.fields, schema);
  const whereParts: string[] = ["collection = ?"];
  if (view.filter) {
    const compiled = compileFilter(
      view.filter,
      options.params ?? {},
      options.ctxUserId,
      schema,
    );
    whereParts.push(`(${compiled.sql})`);
    sqlParams.push(...compiled.params);
  }
  const listQuery = compileListQuery(options, (field) => fieldRefExpr(field, schema));
  whereParts.push(...listQuery.conditions);
  sqlParams.push(...listQuery.params);
  const where = `WHERE ${whereParts.join(" AND ")}`;
  const orderBy = buildOrderBy(view.orderBy, schema);
  const effectiveShow = clampShow(options.show, view.limit);
  const effectivePage = clampPage(options.page);
  // Cap the offset so a huge `?page=` can't render in exponential
  // notation (`5e+21`) or exceed SQLite's INT64 range — either makes
  // D1 reject the literal and surfaces as a 500 instead of an empty
  // page. MAX_SAFE_INTEGER (~9e15) stringifies as plain digits and is
  // well under INT64 max; any page past the data just returns no rows.
  const offset = Math.min((effectivePage - 1) * effectiveShow, Number.MAX_SAFE_INTEGER);
  const sql = `SELECT ${selectExpr} FROM entries ${where}${orderBy} LIMIT ${effectiveShow} OFFSET ${offset}`;
  return { sql, params: sqlParams, effectivePage, effectiveShow };
}

function compileSqlView(
  view: Extract<LogicalViewPlan, { readonly kind: "native" }>,
  options: CompileViewOptions,
): CompiledView {
  const params: unknown[] = [];
  // ponytail: token regex is enough for agent-authored SQL; add a lexer if
  // quoted SQL literals containing `:name` become a real manifest use case.
  const statement = view.statement.trim().replace(
    /:([A-Za-z_][A-Za-z0-9_]*)/g,
    (_token, name: string) => {
      const value = options.params?.[name];
      if (value === undefined) throw new Error(`View SQL requires param '${name}'.`);
      params.push(value);
      return "?";
    },
  );
  const effectiveShow = clampShow(options.show, view.limit);
  const effectivePage = clampPage(options.page);
  const offset = Math.min((effectivePage - 1) * effectiveShow, Number.MAX_SAFE_INTEGER);
  const listQuery = compileListQuery(
    options,
    (field) => `"_mantle_view".${quoteIdent(field)}`,
  );
  const where = listQuery.conditions.length > 0
    ? ` WHERE ${listQuery.conditions.join(" AND ")}`
    : "";
  return {
    sql: `SELECT * FROM (${statement}) AS "_mantle_view"${where} LIMIT ${effectiveShow} OFFSET ${offset}`,
    params: [...params, ...listQuery.params],
    effectivePage,
    effectiveShow,
  };
}

function compileListQuery(
  options: CompileViewOptions,
  fieldRef: (field: string) => string,
): { readonly conditions: readonly string[]; readonly params: readonly unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const term = options.search?.term.trim();
  if (term && options.search?.fields.length) {
    const escaped = escapeLikeTerm(term);
    conditions.push(`(${options.search.fields
      .map((field) => `${fieldRef(field)} LIKE '%'||?||'%' ESCAPE '\\'`)
      .join(" OR ")})`);
    params.push(...options.search.fields.map(() => escaped));
  }
  for (const filter of options.filters ?? []) {
    conditions.push(`CAST(${fieldRef(filter.field)} AS TEXT) = ?`);
    params.push(filter.value);
  }
  return { conditions, params };
}

function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildSelect(
  fields?: readonly string[],
  schema?: SchemaManifest,
): string {
  if (!fields || fields.length === 0) return DEFAULT_PROJECTION;
  return fields.map((field) => fieldExpr(field, schema)).join(", ");
}

function fieldExpr(field: string, schema?: SchemaManifest): string {
  const reserved = RESERVED_COLUMN[field];
  const expression = fieldRefExpr(field, schema);
  if (reserved === field) return expression;
  return `${expression} AS ${reserved ? field : quoteIdent(field)}`;
}

function fieldRefExpr(field: string, schema?: SchemaManifest): string {
  const reserved = RESERVED_COLUMN[field];
  if (reserved) return reserved;
  const indexed = schema ? schemaIndexedFieldSql(schema, field) : null;
  if (indexed) return indexed;
  return `json_extract(data, ${quotedJsonPath(field)})`;
}

interface CompiledFragment {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function compileFilter(
  node: FilterAst,
  paramValues: Record<string, unknown>,
  ctxUserId?: string,
  schema?: SchemaManifest,
): CompiledFragment {
  const comparison = getFilterComparison(node);
  if (comparison) {
    const value = comparison.node.value;
    let bound: unknown;
    if (isCtxUserRef(value)) {
      if (!ctxUserId) {
        throw new DiagnosticError(
          runtimeDiagnostic({
            code: "UNAUTHENTICATED",
            severity: "error",
            path: "compileView/filter",
            expected: "ctx.user.id for an identity-bound View filter",
            message: "View filter requires ctx.user.id.",
          }),
        );
      }
      bound = ctxUserId;
    } else if (isParamRef(value)) {
      const resolved = paramValues[value.$param];
      if (resolved === undefined) {
        throw new Error(`View filter requires param '${value.$param}'.`);
      }
      bound = resolved;
    } else {
      bound = value;
    }
    return {
      sql: `${fieldRefExpr(comparison.node.field, schema)} ${SQL_COMPARISON_OP[comparison.op]} ?`,
      params: [bound],
    };
  }
  const op = "and" in node ? "AND" : "OR";
  const children = "and" in node ? node.and : "or" in node ? node.or : [];
  const compiled = children
    .map((c) => compileFilter(c, paramValues, ctxUserId, schema));
  return {
    sql: compiled.map((c) => `(${c.sql})`).join(` ${op} `),
    params: compiled.flatMap((c) => c.params),
  };
}

function getFilterComparison(
  node: FilterAst,
): { readonly op: FilterComparisonOp; readonly node: FilterComparisonNode } | null {
  if ("eq" in node) return { op: "eq", node: node.eq as FilterComparisonNode };
  if ("gt" in node) return { op: "gt", node: node.gt as FilterComparisonNode };
  if ("gte" in node) return { op: "gte", node: node.gte as FilterComparisonNode };
  if ("lt" in node) return { op: "lt", node: node.lt as FilterComparisonNode };
  if ("lte" in node) return { op: "lte", node: node.lte as FilterComparisonNode };
  return null;
}

function buildOrderBy(
  orderBy?: ReadonlyArray<{ readonly field: string; readonly direction?: "asc" | "desc" }>,
  schema?: SchemaManifest,
): string {
  if (!orderBy || orderBy.length === 0) return "";
  const parts = orderBy.map((o) => {
    // Closed-set map, never interpolate the raw value: `direction` is
    // only a compile-time "asc"|"desc" type, but manifests are parsed
    // from YAML, so an out-of-enum string (e.g. `DESC LIMIT 0 --`)
    // could otherwise reach the SQL string verbatim.
    const dir = o.direction === "desc" ? "DESC" : "ASC";
    return `${fieldRefExpr(o.field, schema)} ${dir}`;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}

// Schema JSON property keys can be arbitrary strings per RFC 8259,
// but SQLite's JSON1 path syntax (`$."key"`) has no documented way
// to escape an inner `"` or `\` inside a quoted key — doubled-quote
// escaping is the SQLite identifier convention, NOT a JSON-path
// convention. So we always quote the path/alias (admitting hyphens,
// spaces, etc.) but refuse `"`, `\`, and `\0` in field names —
// those break either the JSON-path resolution or the SQL string
// literal. Real Schema authors don't use those characters in keys;
// rejecting them keeps the path always-resolvable.

const FORBIDDEN_FIELD_CHARS = /["\\\0]/;

function assertFieldNameSafe(name: string, callsite: string): void {
  if (!FORBIDDEN_FIELD_CHARS.test(name)) return;
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "INTERNAL_ERROR",
      severity: "error",
      path: `compileView/${callsite}`,
      value: name,
      expected: 'field name without `"`, `\\`, or NUL',
      message: `field name '${name}' contains an unrepresentable character (\", \\, or NUL); Schema validation should have caught this.`,
    }),
  );
}

/**
 * Emit `'$."<field>"'` — a SQL string literal containing a SQLite
 * JSON path. Doubles single quotes for the surrounding SQL literal
 * (SQLite literal escape). Field name itself is guaranteed free of
 * `"` / `\` / NUL by `assertFieldNameSafe`, so the inner double-
 * quoted key needs no further escape.
 */
function quotedJsonPath(field: string): string {
  assertFieldNameSafe(field, "quotedJsonPath");
  // Only `'` needs escaping for the surrounding SQL literal; field
  // is guaranteed free of `"` / `\` / NUL.
  return `'$."${field.replace(/'/g, "''")}"'`;
}

/**
 * SQLite quoted-identifier alias (`"hero-image"`). Used as the result
 * column name so callers read the field back under its declared key.
 */
function quoteIdent(name: string): string {
  assertFieldNameSafe(name, "quoteIdent");
  return `"${name}"`;
}
