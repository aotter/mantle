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
import type { UserScope } from "./UserFields.js";
export type SqlNode = Record<string, any>;

/** The PostgreSQL grammar version a plan records (libpg-query 18: PG 18.0.4). */
export const PG_GRAMMAR = 180004;

/** The `SQL_*` codes of the diagnostic kernel; each is described in docs/handbook/reference/diagnostics.md. */
export type SqlDiagnosticCode = Extract<DiagnosticCode, `SQL_${string}` | `USER_FIELD_${string}` | "USER_REF_SCOPE_ONLY" | "AUTH_ROLE_REMOVED">;

export interface SqlSchemaDef {
  /** Translation reads share their parent's current visibility on this field. */
  readonly translates?: { readonly parent: string; readonly on: string };
  /** column that holds the owner; every read and write is filtered on it */
  readonly scope?: string;
  /** AND-joined value terms of the row template, beside the owner column `scope`. */
  readonly userScopes?: readonly UserScope[];
  /** a declared timestamptz field the author writes; a row is invisible once it is `ttlSeconds` old (a NULL never expires) */
  readonly ttl?: string;
  readonly ttlSeconds?: number;
  /** lifecycle `publishing`: a public caller sees only published rows */
  readonly publishing?: boolean;
  /** declared fields and their Mantle types: text integer real bool json timestamptz date numeric(p,s) geo */
  readonly fields: Readonly<Record<string, string>>;
  /** lower-cased column -> the name the JSON Schema declares (the plan has it; `notNullColumns` reads it with `schema`) */
  readonly names?: Readonly<Record<string, string>>;
  /** the Schema's JSON Schema, of which storage reads only what is required and nullable */
  /** `spec.lock` (#1822): `when` is the IR of its boolean over the existing row, whose subqueries read stored rows (`system`). */
  readonly locks?: readonly SqlLock[];
  readonly schema?: { readonly required?: readonly string[]; readonly properties?: Readonly<Record<string, { readonly type?: unknown; readonly nullable?: boolean; readonly enum?: readonly unknown[]; readonly oneOf?: readonly { readonly const?: unknown }[] }>> };
}

export interface SqlLock { readonly name: string; readonly on: readonly ("update" | "delete")[]; readonly when: SqlNode; readonly message: string }

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

/** Shared-cache eligibility of validated, expanded View IR; source text is display metadata, not execution. */
export function viewCacheProblem(stmts: readonly SqlNode[], schemas: Readonly<Record<string, SqlSchemaDef>>): string | undefined {
  const pending: unknown[] = [...stmts];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    const n = node as SqlNode;
    const fn = n.FuncCall?.funcname?.map((x: SqlNode) => x.String.sval).join(".").replace(/^pg_catalog\./, "");
    if (fn === "now" || fn?.startsWith("auth.")) return `shared caching cannot read ${fn}()`;
    const relation = n.RangeVar;
    if (relation?.mantle === "table") {
      const schema = schemas[relation.relname.toLowerCase()];
      if (schema?.userScopes?.length) return `shared caching cannot read field-scoped Schema '${relation.relname}'`;
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
  if (s.publishing) { cols.set("status", "text"); cols.set("published_at", "timestamptz"); }
  for (const [f, t] of Object.entries(s.fields ?? {})) {
    if (f === s.scope) continue;
    if (t === "geo") { cols.set(`${f}_lat`, "real"); cols.set(`${f}_lng`, "real"); } else cols.set(f, t);
  }
  return cols;
}

/** The aggregate functions either dialect's SQL may call: outside a window and without GROUP BY, one makes a select return one row even over none. */
export const AGGREGATES: ReadonlySet<string> = new Set(["count", "sum", "min", "max", "avg", "json_group_array", "json_group_object", "string_agg", "jsonb_agg", "jsonb_object_agg"]);
/** The native columns storage declares NOT NULL (`status` only on a publishing Schema, the only one that has it); `author_id` is nullable. */
export const NATIVE_NOT_NULL: ReadonlySet<string> = new Set(["id", "version", "created_at", "updated_at", "status"]);
/** Each native field a manifest names (in an index, say) -> its storage column, which SQL names. */
export const NATIVE_COLUMNS: Readonly<Record<string, string>> = { id: "id", status: "status", version: "version", createdAt: "created_at", updatedAt: "updated_at", authorId: "author_id" };

/**
 * The columns an `operational` Schema's database refuses NULL in beyond the native ones: each field its JSON Schema requires and
 * does not allow null (a geo field as its two columns). A `publishing` Schema has none: its drafts may be incomplete. This is the one
 * rule; the initial storage SQL of both dialects and the generated Store's `orderBy` type read it.
 */
export function notNullColumns(s: SqlSchemaDef): Set<string> {
  const out = new Set<string>();
  for (const u of s.userScopes ?? []) out.add(u.column);
  if (s.publishing || !s.schema?.required) return out;
  const required = new Set(s.schema.required);
  for (const [f, t] of Object.entries(s.fields)) {
    const authored = s.names?.[f] ?? f, p = s.schema.properties?.[authored];
    if (f === s.scope || !required.has(authored) || !p || p.nullable === true || (Array.isArray(p.type) && p.type.includes("null"))) continue;
    if (t === "geo") out.add(`${f}_lat`).add(`${f}_lng`); else out.add(f);
  }
  return out;
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

const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);
/**
 * Why a Schema lock's `when` (the compiled WHERE of a read of `table`) is outside the lock subset, or undefined (#1822). It names
 * the locked row's columns (unqualified, or qualified with the Schema's name) through comparisons, AND/OR/NOT and IS [NOT] NULL,
 * and `[NOT] EXISTS (SELECT … FROM <declared Schema> [alias] WHERE …)`. Inside a subquery every column is qualified, so an
 * unqualified name can never silently read the subquery's table instead of the locked row. No function call (`now()`, `auth.*`,
 * aggregates, windows), cast, parameter or write.
 */
export function lockShapeProblem(where: SqlNode, schemas: Readonly<Record<string, SqlSchemaDef>>, table: string): string | undefined {
  type Frame = { alias: string; columns: ReadonlyMap<string, string> };
  const columnsOf = (name: string) => storageColumns(schemas[name]!);
  const shape = "a lock's when allows columns, constants, comparisons, AND/OR/NOT, IS [NOT] NULL and [NOT] EXISTS (SELECT … FROM <Schema> WHERE …)";
  const column = (n: SqlNode, frames: readonly Frame[]): string | undefined => {
    const f: (string | undefined)[] = (n.fields ?? []).map((x: SqlNode) => x?.String?.sval);
    if (f.some((x) => x === undefined) || f.length > 2) return `${shape}: ${f.map((x) => x ?? "*").join(".")} is not a column`;
    if (f.length === 1) {
      if (frames.length > 1) return `inside a subquery qualify every column: '${f[0]}' would read the subquery's table, not the locked row; write ${table}.${f[0]} for the locked row`;
      return frames[0]!.columns.has(f[0]!) ? undefined : `'${f[0]}' is not a column of ${table}`;
    }
    const frame = [...frames].reverse().find((x) => x.alias === f[0]);
    if (!frame) return `'${f[0]}' is neither ${table} nor a subquery's alias`;
    return frame.columns.has(f[1]!) ? undefined : `'${f[1]}' is not a column of ${f[0]}`;
  };
  const value = (n: SqlNode | undefined, frames: readonly Frame[]): string | undefined => {
    if (n?.A_Const) return undefined;
    if (n?.ColumnRef) return column(n.ColumnRef, frames);
    if (n?.List) { for (const x of n.List.items ?? []) { const p = value(x, frames); if (p) return p; } return undefined; }
    if (n?.FuncCall) return "a lock calls no function: now(), auth.*, aggregates and window functions are refused, so it holds the same for every caller and every request";
    return `${shape}: ${Object.keys(n ?? {})[0] ?? "this expression"} is refused`;
  };
  const sub = (s: SqlNode | undefined, frames: readonly Frame[]): string | undefined => {
    const from: SqlNode[] = s?.fromClause ?? [];
    if (!s || s.op !== "SETOP_NONE" || s.withClause || s.groupClause || s.havingClause || s.distinctClause || s.sortClause || s.limitCount || s.limitOffset || s.windowClause || s.valuesLists || from.length !== 1 || !from[0]!.RangeVar)
      return "a lock's subquery is SELECT … FROM one declared Schema [alias] WHERE …: no join, WITH, GROUP BY, ORDER BY, LIMIT, DISTINCT or set operation";
    const rv = from[0]!.RangeVar, name = String(rv.relname).toLowerCase();
    if (rv.mantle !== "table" || !schemas[name]) return `${rv.relname} is not a declared Schema`;
    const alias = rv.alias?.aliasname ?? rv.relname;
    if (frames.some((x) => x.alias === alias)) return `the subquery's '${alias}' hides a name already in scope (the locked row is ${table}): give it its own alias`;
    const inner = [...frames, { alias, columns: columnsOf(name) }];
    for (const t of s.targetList ?? []) { const p = value(t.ResTarget?.val, inner); if (p) return p; }
    return s.whereClause ? expr(s.whereClause, inner) : undefined;
  };
  const expr = (n: SqlNode, frames: readonly Frame[]): string | undefined => {
    if (n.BoolExpr) { for (const x of n.BoolExpr.args) { const p = expr(x, frames); if (p) return p; } return undefined; }
    if (n.NullTest) return value(n.NullTest.arg, frames);
    if (n.SubLink) return n.SubLink.subLinkType === "EXISTS_SUBLINK" ? sub(n.SubLink.subselect?.SelectStmt, frames) : `${shape}: only an EXISTS subquery`;
    const e = n.A_Expr;
    if (e && ((e.kind === "AEXPR_OP" && COMPARISONS.has(e.name?.[0]?.String?.sval) && e.lexpr) || (e.kind === "AEXPR_IN" && e.rexpr?.List))) return value(e.lexpr, frames) ?? value(e.rexpr, frames);
    return value(n, frames);
  };
  return expr(where, [{ alias: table, columns: columnsOf(table) }]);
}

/**
 * Whether every EXISTS of a lock (already `lockShapeProblem`-free) is index-served (#1822): its equality predicates (top-level AND
 * terms `col = <constant or outer column>` on the subquery's own Schema) must include the first column of a declared index, unique
 * index or `id` of that Schema. Each lock runs on every guarded write, so an unindexed EXISTS would scan its table each time.
 * Returns the first unproved subquery: its Schema and the columns an index could lead with.
 */
export function lockIndexProblem(where: SqlNode, schemas: Readonly<Record<string, SqlSchemaDef & { readonly unique?: readonly (readonly string[])[]; readonly indexes?: readonly (readonly string[])[] }>>): { schema: string; columns: string[]; or?: true } | undefined {
  const walk = (n: unknown): { schema: string; columns: string[]; or?: true } | undefined => {
    if (!n || typeof n !== "object") return undefined;
    const s = (n as SqlNode).SubLink?.subselect?.SelectStmt;
    if (s) {
      const rv = s.fromClause[0].RangeVar, name = String(rv.relname).toLowerCase(), alias = rv.alias?.aliasname ?? rv.relname, def = schemas[name]!;
      const own = (x: SqlNode | undefined) => x?.ColumnRef?.fields?.length === 2 && x.ColumnRef.fields[0].String?.sval === alias ? String(x.ColumnRef.fields[1].String.sval) : undefined;
      const other = (x: SqlNode | undefined) => !!x?.A_Const || (x?.ColumnRef?.fields?.length === 2 && x.ColumnRef.fields[0].String?.sval !== alias);
      const terms = (x: SqlNode | undefined): SqlNode[] => x?.BoolExpr?.boolop === "AND_EXPR" ? x.BoolExpr.args.flatMap(terms) : x ? [x] : [];
      const columns = [...new Set(terms(s.whereClause).flatMap((t) => {
        const e = t.A_Expr;
        // `col IN (<constants>)` is a set of equalities the index serves
        if (e?.kind === "AEXPR_IN" && own(e.lexpr) && e.rexpr?.List?.items?.every((x: SqlNode) => x.A_Const)) return [own(e.lexpr)!];
        if (e?.kind !== "AEXPR_OP" || e.name?.[0]?.String?.sval !== "=") return [];
        const c = own(e.lexpr) && other(e.rexpr) ? own(e.lexpr) : own(e.rexpr) && other(e.lexpr) ? own(e.rexpr) : undefined;
        return c ? [c] : [];
      }))];
      if (![["id"], ...(def.indexes ?? []), ...(def.unique ?? [])].some((index) => columns.includes(index[0]!)))
        return { schema: name, columns, ...(!columns.length && JSON.stringify(s.whereClause ?? null).includes('"OR_EXPR"') ? { or: true as const } : {}) };
    }
    for (const v of Object.values(n)) { const p = walk(v); if (p) return p; }
    return undefined;
  };
  return walk(where);
}
