/**
 * Store SQL and its IR (ADR-0034). The IR is libpg-query's parse tree for the
 * supported subset, with source locations stripped and every relation tagged
 * `table` or `cte`. Mantle designs no node types, so nodes are typed loosely on
 * purpose: the dialect's allowlist (`src/core/sql/allowlist.ts`), not a TypeScript type, constrains
 * them.
 *
 * Pure types and constants only. Nothing here imports the parser.
 */
import type { DiagnosticCode } from "../../kernel/diagnostic.js";
export type SqlNode = Record<string, any>;

/** The PostgreSQL grammar version a plan records (libpg-query 18: PG 18.0.4). */
export const PG_GRAMMAR = 180004;

/** The `SQL_*` codes of the diagnostic kernel; each is described in docs/handbook/reference/diagnostics.md. */
export type SqlDiagnosticCode = Extract<DiagnosticCode, `SQL_${string}`>;

export interface SqlSchemaDef {
  /** column that holds the owner; every read and write is filtered on it */
  readonly scope?: string;
  /** a declared timestamptz field the author writes; a row is invisible once it is `ttlSeconds` old (a NULL never expires) */
  readonly ttl?: string;
  readonly ttlSeconds?: number;
  /** lifecycle `publishing`: a public caller sees only published rows */
  readonly publishing?: boolean;
  /** declared fields and their Mantle types: text integer real bool json timestamptz date numeric(p,s) geo */
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * What the allowlist reads off every Schema of a context: computed from `schemas` (`schemaColumns`), once per plan by a caller that
 * checks many programs against one plan, or per program when absent.
 */
export interface SchemaColumns {
  /** every declared column name (a geo field also as its `_lat` and `_lng` columns) */
  readonly known: ReadonlySet<string>;
  /** the scope columns, folded */
  readonly scopes: ReadonlySet<string>;
  /** column name -> its type, when every Schema that declares it agrees */
  readonly types: ReadonlyMap<string, string>;
}

export interface SqlContext {
  readonly schemas: Readonly<Record<string, SqlSchemaDef>>;
  /** `schemaColumns(schemas)`, precomputed; must be of these `schemas` */
  readonly columns?: SchemaColumns;
  /** declared input properties and their Mantle types */
  readonly inputs: Readonly<Record<string, string>>;
  readonly kind: "view" | "procedure";
  /** a public View: a caller sees published rows only, even across a join */
  readonly public?: boolean;
  /**
   * The Views a FROM may name (ADR-0037 decision 3), by name with `-` as `_`: an internal View's validated tagged SELECT, which the
   * compiler expands as D1 CTE dependencies or native FROM subqueries, or why that View cannot be read. Compile side only.
   */
  readonly views?: Readonly<Record<string, { readonly select?: SqlNode; readonly refusal?: string }>>;
}

/** A refusal of Store SQL. `line` and `column` are 1-based; `token` is the source text there. */
export interface SqlDiagnostic {
  readonly code: SqlDiagnosticCode;
  readonly message: string;
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
  readonly token?: string;
}

/** What the plan carries for one SQL source: the grammar it was parsed by, and the IR statements. */
export interface SqlPlan {
  readonly grammar: number;
  readonly stmts: readonly SqlNode[];
}

/** Whether an expression holds a subquery, by structure: a string literal 'SubLink' is not one. */
export function hasSubLink(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, c]) => k === "SubLink" || hasSubLink(c));
}

/** Shared-cache eligibility of validated, expanded View IR; source text is display metadata, not execution. */
export function viewCacheProblem(stmts: readonly SqlNode[], schemas: Readonly<Record<string, SqlSchemaDef>>): string | undefined {
  const pending: unknown[] = [...stmts];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    const n = node as SqlNode;
    const fn = n.FuncCall?.funcname?.map((x: SqlNode) => x.String.sval).join(".").replace(/^pg_catalog\./, "");
    if (fn === "now" || fn === "auth.uid" || fn === "auth.role") return `shared caching cannot read ${fn}()`;
    const relation = n.RangeVar;
    if (relation?.mantle === "table") {
      const schema = schemas[relation.relname.toLowerCase()];
      if (schema?.ttl || (schema && !schema.publishing)) return `shared caching cannot read ${schema.ttl ? "TTL" : "operational"} Schema '${relation.relname}'`;
    }
    pending.push(...Object.values(n));
  }
  return undefined;
}

/**
 * The columns storage creates for a Schema, each with its type: the native ones, the scope field, `status` on a publishing Schema,
 * and each field (a geo field as its `_lat` and `_lng` columns). `created_at`/`updated_at` are typed per dialect, so `native`.
 */
export function storageColumns(s: { readonly fields?: Readonly<Record<string, string>>; readonly scope?: string; readonly publishing?: boolean }): Map<string, string> {
  const cols = new Map<string, string>([["_rid", "integer"], ["id", "text"], ["version", "integer"], ["created_at", "native"], ["updated_at", "native"], ["author_id", "text"]]);
  if (s.scope) cols.set(s.scope, "text");
  if (s.publishing) cols.set("status", "text");
  for (const [f, t] of Object.entries(s.fields ?? {})) {
    if (f === s.scope) continue;
    if (t === "geo") { cols.set(`${f}_lat`, "real"); cols.set(`${f}_lng`, "real"); } else cols.set(f, t);
  }
  return cols;
}

/** A field whose name is a column storage creates for something else (`_rid`, or another geo field's `_lat`/`_lng`), or undefined. */
export function storageColumnClash(fields: Readonly<Record<string, string>>): string | undefined {
  const taken = new Set(["_rid", ...Object.entries(fields).filter(([, t]) => t === "geo").flatMap(([f]) => [`${f}_lat`, `${f}_lng`])]);
  return Object.keys(fields).find((f) => taken.has(f));
}

/** The functions a Schema check may call, by their bare name: each takes one argument of a type SQLite and PostgreSQL both accept. */
export const CHECK_FUNCTIONS: ReadonlyMap<string, { readonly takes: readonly string[]; readonly returns: "text" | "integer" | "argument" }> = new Map([
  ["lower", { takes: ["text"], returns: "text" }], ["upper", { takes: ["text"], returns: "text" }],
  ["length", { takes: ["text"], returns: "integer" }], ["abs", { takes: ["integer", "real"], returns: "argument" }],
]);

/**
 * Why a Schema check cannot run in the table's DDL as written, or undefined. Storage prints a check unlowered into a trigger or
 * CHECK constraint, so it names only `columns` (`storageColumns` of its own Schema, unqualified) through operators and
 * `CHECK_FUNCTIONS`: no subquery, no cast, and nothing the runtime binds per request (`auth.uid()`, `now()`) or a dialect spells
 * its own way. Operand types beyond the functions' arguments are the database's to check at boot.
 */
export function checkShapeProblem(v: unknown, columns: ReadonlyMap<string, string>): string | undefined {
  const columnOf = (ref: { fields?: unknown }) => {
    const fields = ref?.fields;
    const name = Array.isArray(fields) && fields.length === 1 ? (fields[0] as { String?: { sval?: unknown } })?.String?.sval : undefined;
    return typeof name === "string" && columns.has(name) ? name : undefined;
  };
  // as written: storage prints the call unlowered, so `pg_catalog.lower` is not `lower` to SQLite
  const fname = (call: { funcname?: unknown }) => Array.isArray(call?.funcname) ? call.funcname.map((x: any) => x?.String?.sval).join(".") : "";
  const typeOf = (n: Record<string, any> | undefined): string | undefined => {
    if (n?.ColumnRef) return columns.get(columnOf(n.ColumnRef) ?? "");
    if (n?.FuncCall) { const f = CHECK_FUNCTIONS.get(fname(n.FuncCall)); return f?.returns === "argument" ? typeOf(n.FuncCall.args?.[0]) : f?.returns; }
    if (n?.A_Const) return n.A_Const.sval ? "text" : n.A_Const.ival ? "integer" : n.A_Const.fval ? "real" : undefined;
    return undefined;
  };
  const walk = (v: unknown): string | undefined => {
    if (!v || typeof v !== "object") return undefined;
    for (const [k, c] of Object.entries(v) as [string, any][]) {
      if (k === "SubLink") return "a check reads only the row's own columns: no subquery";
      if (k === "TypeCast" || k === "SQLValueFunction") return "a check reads only the row's own columns: no cast or SQL value function";
      if (k === "ColumnRef" && !columnOf(c)) return `a check names only its own Schema's columns, unqualified: ${JSON.stringify((c?.fields ?? []).map((x: any) => x?.String?.sval ?? "*").join("."))} is not one`;
      if (k === "FuncCall") {
        const name = fname(c);
        const takes = CHECK_FUNCTIONS.get(name)?.takes;
        if (!takes) return `a check may call only ${[...CHECK_FUNCTIONS.keys()].join(", ")}: ${name || "this call"}() is printed into the table's DDL as written`;
        if (c.agg_star || c.agg_distinct || c.agg_filter || c.agg_order || c.over || !Array.isArray(c.args) || c.args.length !== 1) return `${name}() in a check takes one argument, with no DISTINCT, *, FILTER, ORDER BY or OVER`;
        const t = typeOf(c.args[0]);
        if (!t || !takes.includes(t)) return `${name}() in a check takes a ${takes.join(" or ")} column, constant or call`;
      }
      const inner = walk(c);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(v);
}
