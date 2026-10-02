/**
 * What no dialect may run (ADR-0035 decision 4), refused before the dialect's `accepts` sees the tree. A dialect may refuse
 * more; it never has to refuse these itself. Runs on the raw AST, so every refusal has a source offset. A relation that
 * names a CTE in scope is tagged `cte`, so no dialect reads it as a table.
 */
import type { SqlContext, SqlNode as N } from "../../domain/model/SqlIr.js";
import { SqlRefusal } from "../../domain/service/SqlRefusal.js";

const STATEMENTS = new Set(["SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);
const WRITES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);
/** The functions of decision 2: the only members of the `mantle` and `auth` schemas. */
const MANTLE_FUNCTIONS = new Set(["mantle.search", "mantle.search_rank", "mantle.near", "mantle.distance", "auth.uid", "auth.role"]);
/** Functions that change session or server state, reach outside the database, or run SQL text the front end cannot see. */
const OUTSIDE = /^(pg_(try_)?advisory_|pg_read_(binary_)?file$|pg_ls_|pg_stat_file$|pg_file_|lo_|dblink|pg_(cancel|terminate|signal)_backend$|pg_reload_conf$|pg_rotate_logfile$|pg_notify$|(set|next)val$|(query|table|cursor|schema|database)_to_xml|ts_stat$|ts_rewrite$)/;

const no = (code: ConstructorParameters<typeof SqlRefusal>[0], message: string, at: number | undefined): never => {
  throw new SqlRefusal(code, message, at);
};

/** A function's name as PostgreSQL resolves it: a leading catalog (`db.schema.f`) and `pg_catalog.` dropped, case folded. */
function functionName(n: N): string {
  const parts = (n.funcname as N[]).map((x) => String(x.String?.sval).toLowerCase());
  return parts.slice(-2).join(".").replace(/^pg_catalog\./, "");
}

export function refuseForEveryDialect(stmts: readonly N[], ctx: SqlContext, locations: readonly (number | undefined)[]): void {
  if (ctx.kind === "view" && (stmts.length !== 1 || !stmts[0]!.SelectStmt)) no("SQL_SHAPE", "a View is exactly one SELECT", locations[1] ?? locations[0]);
  stmts.forEach((stmt, i) => {
    const type = Object.keys(stmt)[0]!;
    if (!STATEMENTS.has(type)) no("SQL_UNSUPPORTED", `statement ${type} is refused`, locations[i]);
    walk(stmt, new Set(), locations[i], ctx);
  });
}

/** Walk a subtree with the CTE names in scope. PostgreSQL's rule: a CTE sees earlier siblings (every sibling when RECURSIVE). */
function walk(v: unknown, ctes: ReadonlySet<string>, at: number | undefined, ctx: SqlContext): void {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, ctes, at, ctx));
  if (!v || typeof v !== "object") return;
  for (const [k, c] of Object.entries(v as N)) {
    if (!c || typeof c !== "object" || Array.isArray(c)) { walk(c, ctes, at, ctx); continue; }
    const n = c as N;
    const here = typeof n.location === "number" ? n.location : at;
    // a write's target is a RangeVar without its type key
    if (k === "RangeVar" || k === "relation") relation(n, ctes, here, ctx, k === "relation");
    // a set operation's branches are SELECT bodies without their type key, each with its own WITH
    else if (STATEMENTS.has(k) || ((k === "larg" || k === "rarg") && "op" in n)) {
      if (ctx.kind === "view" && WRITES.has(k)) no("SQL_SHAPE", "a View reads only: no write in a WITH", here);
      if (n.intoClause) no("SQL_UNSUPPORTED", "SELECT ... INTO creates a table and is refused", here);
      const w = n.withClause as N | undefined;
      const names = ((w?.ctes ?? []) as N[]).map((x) => String(x.CommonTableExpr.ctename));
      ((w?.ctes ?? []) as N[]).forEach((x, j) => walk(x.CommonTableExpr.ctequery, new Set([...ctes, ...(w!.recursive ? names : names.slice(0, j))]), here, ctx));
      const inner = new Set([...ctes, ...names]);
      for (const [key, body] of Object.entries(n)) if (key !== "withClause") walk({ [key]: body }, inner, here, ctx);
      continue;
    } else if (k === "ColumnRef") {
      const f = (n.fields as N[]).map((x) => x.String?.sval);
      if (f.length === 2 && f[0] === "input" && !Object.hasOwn(ctx.inputs, String(f[1]))) no("SQL_COLUMN", `input.${f[1]} is not a declared input`, here);
    } else if (k === "FuncCall") {
      const f = functionName(n);
      if (/^(mantle|auth)\./.test(f) && !MANTLE_FUNCTIONS.has(f)) no("SQL_FUNCTION", `${f} is not one of Mantle's functions`, here);
      if (OUTSIDE.test(f)) no("SQL_FUNCTION", `${f} changes session or server state, or reaches outside the database`, here);
      const setting = (n.args as N[] | undefined)?.[0]?.A_Const?.sval?.sval;
      // a caller setting could be forged from SQL: a name that is not a literal outside mantle.* is refused (setting names ignore case)
      if ((f === "set_config" || f === "current_setting") && (typeof setting !== "string" || setting.toLowerCase().startsWith("mantle."))) no("SQL_FUNCTION", `${f} of a mantle.* setting is refused`, here);
    }
    walk(n, ctes, here, ctx);
  }
}

/**
 * A relation is a CTE in scope, a declared Schema, or an internal View (ADR-0037 decision 3), by PostgreSQL's name rules
 * (unquoted names are already folded). A View is tagged `view`; the compiler inlines it before any dialect sees the tree.
 */
function relation(n: N, ctes: ReadonlySet<string>, at: number | undefined, ctx: SqlContext, written: boolean): void {
  const name = String(n.relname);
  if (n.schemaname || n.catalogname) no("SQL_RELATION", `${n.schemaname ?? n.catalogname}.${name}: a relation is a declared Schema, never schema-qualified`, at);
  if (ctes.has(name)) { n.mantle = "cte"; return; }
  const view = Object.hasOwn(ctx.schemas, name) ? undefined : ctx.views?.[name];
  if (view) {
    if (written) no("SQL_WRITE", `${name} is a View: a View is read, never written`, at);
    if (view.refusal) no("SQL_RELATION", view.refusal, at);
    n.mantle = "view";
    return;
  }
  if (!Object.hasOwn(ctx.schemas, name)) no("SQL_RELATION", `${name} is not a declared Schema`, at);
}
